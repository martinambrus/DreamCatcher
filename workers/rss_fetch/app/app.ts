import {env, exit} from 'node:process';
import { RSSFetch } from "./RSSFetch.js";
import { Logger } from "./Logger.js";
import { KafkaProducer } from "./KafkaProducer.js";
import { KafkaConsumer } from "./KafkaConsumer.js";
import { ILogger } from './KeyStore/Interfaces/ILogger.js';
import { IKeyStoreSub } from './KeyStore/Interfaces/IKeyStoreSub.js';
import { RedisSubClient } from './KeyStore/RedisSubClient.js';
import { RedisPubClient } from './KeyStore/RedisPubClient.js';
import { IKeyStorePub } from './KeyStore/Interfaces/IKeyStorePub.js';

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? 'rss_fetch_' + env.HOSTNAME : 'rss_fetch_undefined_host' );
const SERVICE_ID: string = 'rss_fetch';

( async (): Promise<void> => {
  // Global logger
  const logger: ILogger = new Logger( CLIENT_ID, SERVICE_ID );

  // Redis Sub client
  let redis_sub: IKeyStoreSub = new RedisSubClient( logger );
  await redis_sub.connect( env.KEY_STORE_NODES, env.KEY_STORE_PORT );

  // Redis Pub client
  let redis_pub: IKeyStorePub = new RedisPubClient( logger );
  await redis_pub.connect( env.KEY_STORE_NODES, env.KEY_STORE_PORT );
  logger.set_key_store_pub_client( redis_pub );

  // Kafka producer
  const kafka_producer: KafkaProducer = new KafkaProducer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID );
  await kafka_producer.connect();
  logger.set_mq_broker( kafka_producer );

  // Kafka consumer
  const kafka_consumer: KafkaConsumer = new KafkaConsumer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID );
  await kafka_consumer.connect();

  // create the RSSFetch class instance and run program
  new RSSFetch( kafka_producer, kafka_consumer, logger, SERVICE_ID, redis_sub, redis_pub );
})();