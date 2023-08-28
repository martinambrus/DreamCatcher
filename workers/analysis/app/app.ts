import {env, exit} from 'node:process';
import { Logger } from "./Logger.js";
import { Analysis } from './Analysis.js';
import { KafkaProducer } from "./KafkaProducer.js";
import { KafkaConsumer } from "./KafkaConsumer.js";
import pkg from 'pg';
import { RedisSubClient } from './RedisSubClient.js';
import { RedisPubClient } from './RedisPubClient.js';

const { Client } = pkg;

// PGSQL settings
const POSTGRES_HOST: string = env.POSTGRES_HOST;
const POSTGRES_USER: string = env.POSTGRES_USER;
const POSTGRES_PASSWORD: string = env.POSTGRES_PASSWORD;
const POSTGRES_DB: string = env.POSTGRES_DB;

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? 'analysis_' + env.HOSTNAME : 'analysis_undefined_host' );
const SERVICE_ID: string = 'analysis';

( async (): Promise<void> => {

  // Global logger
  const logger: Logger = new Logger(CLIENT_ID, SERVICE_ID);

  // Redis Sub client
  let redis_sub: RedisSubClient = new RedisSubClient( logger );
  await redis_sub.connect( env.REDIS_NODES, env.REDIS_PORT );

  // Redis Pub client
  let redis_pub: RedisPubClient = new RedisPubClient( logger );
  await redis_pub.connect( env.REDIS_NODES, env.REDIS_PORT );
  logger.set_redis_pub_client( redis_pub );

  // Kafka producer
  const kafka_producer: KafkaProducer = new KafkaProducer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID );
  await kafka_producer.connect();
  logger.set_kafka_producer( kafka_producer );

  // Kafka consumer - new links data
  const kafka_consumer_links: KafkaConsumer = new KafkaConsumer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID + '_links' );
  await kafka_consumer_links.connect();

  // Kafka consumer - RSS errors log
  const kafka_consumer_logs: KafkaConsumer = new KafkaConsumer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID + '_logs' );
  await kafka_consumer_logs.connect();

  // PGSQL class instance
  const dbconn: pkg.Client = new Client({
    host: POSTGRES_HOST,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DB
  });

  // try connecting to PGSQL
  if (!POSTGRES_DB || !POSTGRES_PASSWORD || !POSTGRES_USER) {
    let exit_code: number = parseInt( await redis_pub.get( 'ERR_POSTGRES_MISSING_CONNECTION_DATA' ) );
    await logger.log_msg( 'missing one of POSTGRES environment variables', exit_code );
    exit( exit_code );
  } else {
    // try to connect to PGSQL
    try {
      await dbconn.connect();
    } catch (err) {
      let exit_code: number = parseInt( await redis_pub.get( 'ERR_POSTGRES_CANNOT_CONNECT' ) );
      await logger.log_msg( 'could not connect to POSTGRES\n' + JSON.stringify( err ), exit_code );
      exit( exit_code );
    }
  }

  // create the Analysis class instance and run program
  new Analysis(SERVICE_ID, kafka_producer, kafka_consumer_logs, kafka_consumer_links, logger, dbconn, redis_sub, redis_pub);
})();