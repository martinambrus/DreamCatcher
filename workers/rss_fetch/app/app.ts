import {env, exit} from 'node:process';
import { RSSFetch } from "./RSSFetch.js";
import { Logger } from "./Logger.js";
import { KafkaProducer } from "./KafkaProducer.js";
import { KafkaConsumer } from "./KafkaConsumer.js";
import { RedisSubClient } from './RedisSubClient.js';
import { RedisPubClient } from './RedisPubClient.js';

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? 'rss_fetch_' + env.HOSTNAME : 'rss_fetch_undefined_host' );
const SERVICE_ID: string = 'rss_fetch';

( async (): Promise<void> => {
  // Global logger
  const logger: Logger = new Logger( CLIENT_ID, SERVICE_ID );

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

  // Kafka consumer
  const kafka_consumer: KafkaConsumer = new KafkaConsumer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID );
  await kafka_consumer.connect();

  // create the RSSFetch class instance and run program
  new RSSFetch( kafka_producer, kafka_consumer, logger, SERVICE_ID, redis_sub, redis_pub );
})();