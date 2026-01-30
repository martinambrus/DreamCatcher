import { env, exit } from 'node:process';
import { PrismaClient, Prisma } from '@prisma/client';
import Parser from 'tree-sitter';
import HTML from 'tree-sitter-html';
import { JSDOM } from 'jsdom';
import { franc } from 'franc-min';
import { Kafka } from 'kafkajs';
import { Logger } from './Logger.js';
import { KeyStorePubClient } from './Utils/MQ/KeyStore/KeyStorePubClient.js';
import { IKeyStorePub } from './Utils/MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { MessageQueueSub } from './Utils/MQ/MessageQueueSub.js';
import { IMessageQueueSub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { ILogger, LOG_SEVERITIES } from './Utils/MQ/KeyStore/Interfaces/ILogger.js';
import { queue } from 'async';

const SERVICE_ID = 'rag_chunker';
const CLIENT_ID = env.HOSTNAME ? `${SERVICE_ID}_${env.HOSTNAME}` : `${SERVICE_ID}_unknown_host`;

const prisma = new PrismaClient();

const PARENT_TOKENS = env.RAG_PARENT_TOKENS ? parseInt(env.RAG_PARENT_TOKENS) : 1200;
const CHILD_TOKENS = env.RAG_CHILD_TOKENS ? parseInt(env.RAG_CHILD_TOKENS) : 400;
const CHILD_OVERLAP = env.RAG_CHILD_OVERLAP ? parseInt(env.RAG_CHILD_OVERLAP) : 50;
const LINK_WAIT_MS = env.RAG_LINK_WAIT_MS ? parseInt(env.RAG_LINK_WAIT_MS) : 2000;
const LINK_WAIT_ATTEMPTS = env.RAG_LINK_WAIT_ATTEMPTS ? parseInt(env.RAG_LINK_WAIT_ATTEMPTS) : 15;
const QUEUE_SET_NAME = env.RAG_CHUNKER_QUEUE_SET_NAME ? env.RAG_CHUNKER_QUEUE_SET_NAME : 'rag_chunker_queue_backup';

function log(msg: string) {
  const dt = new Date();
  console.log(`[${dt.getDate()}.${dt.getMonth() + 1}.${dt.getFullYear()} ${dt.getHours()}:${dt.getMinutes()}:${dt.getSeconds()}] ${CLIENT_ID}: ${msg}`);
}

function detectLanguage(text: string): string {
  const code = franc(text || '', { minLength: 50 });
  if (code === 'ces') return 'cs';
  if (code === 'slk') return 'sk';
  if (code === 'eng') return 'en';
  return 'en';
}

function tokenizeWords(text: string): string[] {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function chunkWords(words: string[], size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + size);
    if (slice.length === 0) break;
    chunks.push(slice.join(' '));
    i += size - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

function htmlToText(html: string): string {
  try {
    const parser = new Parser();
    parser.setLanguage(HTML);
    const tree = parser.parse(html || '');
    if (tree.rootNode.hasError) {
      log('tree-sitter detected parse errors; falling back to JSDOM text extraction');
    }
  } catch (err) {
    log(`tree-sitter parse failed: ${(err as Error).message}`);
  }

  const dom = new JSDOM(html || '');
  return (dom.window.document.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

function buildParentChunks(text: string): string[] {
  const words = tokenizeWords(text);
  return chunkWords(words, PARENT_TOKENS, 0);
}

function buildChildChunks(parentText: string): string[] {
  const words = tokenizeWords(parentText);
  return chunkWords(words, CHILD_TOKENS, CHILD_OVERLAP);
}

async function processLink(linkRow: any): Promise<void> {
  const fullText = htmlToText(linkRow.original_body || '');
  if (!fullText || fullText.length < 50) {
    await prisma.links.updateMany({
      where: { id: linkRow.id, feed_id: linkRow.feed_id },
      data: { ingestion_status: 'embedded' },
    });
    log(`Skipping link ${linkRow.id} (too little text).`);
    return;
  }

  const lang = detectLanguage(fullText);
  const parentChunks = buildParentChunks(fullText);

  for (const parentContent of parentChunks) {
    try {
      const parentMeta = JSON.stringify({ feed_id: linkRow.feed_id?.toString(), link_id: linkRow.id?.toString(), lang });
      const parentRows = await prisma.$queryRaw(Prisma.sql`
        INSERT INTO rag_parents (source_type, source_path, title, content, metadata)
        VALUES ('article', ${linkRow.link}, ${linkRow.title || ''}, ${parentContent}, CAST(${parentMeta} AS jsonb))
        RETURNING id
      `);

      const parentId = (parentRows as any[])?.[0]?.id;
      if (!parentId) continue;

      const childChunks = buildChildChunks(parentContent);
      for (const childContent of childChunks) {
        const childMeta = JSON.stringify({ feed_id: linkRow.feed_id?.toString(), link_id: linkRow.id?.toString(), lang });
        const childRows = await prisma.$queryRaw(Prisma.sql`
          INSERT INTO rag_chunks (parent_id, source_type, source_path, section_id, content, metadata)
          VALUES (${parentId}, 'article', ${linkRow.link}, '', ${childContent}, CAST(${childMeta} AS jsonb))
          RETURNING id
        `);
        const childId = (childRows as any[])?.[0]?.id;
        if (childId) {
          await prisma.$executeRaw(Prisma.sql`
            INSERT INTO rag_links (parent_id, child_id) VALUES (${parentId}, ${childId})
            ON CONFLICT DO NOTHING
          `);
        }
      }
    } catch (err: any) {
      const msg = (err && err.message) ? err.message : JSON.stringify(err);
      console.log(`RAG insert error for link ${linkRow.id}: ${msg}`);
      console.log(err);
      throw err;
    }
  }

  await prisma.links.updateMany({
    where: { id: linkRow.id, feed_id: linkRow.feed_id },
    data: { ingestion_status: 'embedded' },
  });

  log(`Processed link ${linkRow.id} (${parentChunks.length} parent chunks).`);
}

async function waitForLinkBody(linkUrl: string): Promise<any | null> {
  for (let i = 0; i < LINK_WAIT_ATTEMPTS; i++) {
    const row = await prisma.links.findFirst({
      where: { link: linkUrl },
      select: {
        id: true,
        feed_id: true,
        title: true,
        link: true,
        original_body: true,
      },
      orderBy: { date_fetched: 'desc' },
    });

    if (row && row.original_body && row.original_body.trim() !== '') {
      return row;
    }

    await new Promise((r) => setTimeout(r, LINK_WAIT_MS));
  }

  return null;
}

async function main(): Promise<void> {
  // Global logger
  const logger: ILogger = new Logger(CLIENT_ID, SERVICE_ID);

  // Redis Pub client
  let redis_pub: IKeyStorePub = new KeyStorePubClient(logger);
  await redis_pub.connect(env.KEY_STORE_NODES, env.KEY_STORE_PORT);
  logger.set_key_store_pub_client(redis_pub);

  // check brokers
  const brokers = (env.MQ_NODES ? env.MQ_NODES.split(',') : []);
  if (brokers.length === 1 && brokers[0] === '') {
    console.log(logger.format('Brokers missing for Kafka! Received: ' + brokers.toString()));
    exit(1);
  }

  console.log(logger.format('Creating Kafka client to connect to the following brokers: ' + brokers.toString()));

  const connection = new Kafka({
    clientId: SERVICE_ID,
    brokers,
    connectionTimeout: 30000,
    authenticationTimeout: 30000,
    requestTimeout: 30000,
  });

  const mq_consumer: IMessageQueueSub = new MessageQueueSub(SERVICE_ID, connection, logger);

  // publish info about our instance going live
  logger.log_msg('rag_chunker up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG);

  // update active status every minute
  setInterval((): void => {
    redis_pub.set(SERVICE_ID + '_active', 1);
  }, 60000);

  const backup_set = (env.HOSTNAME ? 'rag_chunker_' + env.HOSTNAME : 'rag_chunker_undefined_host') + QUEUE_SET_NAME;

  const job_queue = new queue(async (task: any, callback: Function) => {
    try {
      const linkRow = await waitForLinkBody(task.link);
      if (!linkRow) {
        logger.log_msg('No HTML yet for link: ' + task.link, 0, LOG_SEVERITIES.LOG_SEVERITY_NOTICE);
      } else {
        await processLink(linkRow);
      }
    } catch (err) {
      logger.log_msg('Error processing link: ' + task.link + ' err=' + JSON.stringify(err), 'ERR_RAG_CHUNKER_PROCESS');
    } finally {
      // remove from backup set
      await redis_pub.sdelete(backup_set, JSON.stringify(task));
      callback();
    }
  }, 5);

  // restore queued jobs after crash
  redis_pub.smembers(backup_set).then((jobs) => {
    if (jobs.length) {
      console.log(logger.format('resuming ' + jobs.length + ' redis-saved jobs from the previous queue'));
    }

    for (let job of jobs) {
      const job_data = JSON.parse(job);
      job_queue.push(job_data);
    }
  });

  // consume saved links (post-insert)
  const topic = env.SAVED_LINKS_CHANNEL_NAME;
  mq_consumer.consume(topic, async ({ message }) => {
    if (!message || !message.link) return;

    if (message.service === SERVICE_ID) return;

    const job = { link: message.link };
    await redis_pub.sadd(backup_set, JSON.stringify(job));
    job_queue.push(job);
  });
}

log('Starting rag_chunker (Kafka consumer)...');
main().catch((err) => log(`Fatal: ${(err as Error).message}`));
