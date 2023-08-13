import {env, exit} from 'node:process';
import { RSSFetch } from "./RSSFetch.js";
import { createClient } from "redis";
import { Logger } from "./Logger.js";
import { KafkaProducer } from "./KafkaProducer.js";
import { KafkaConsumer } from "./KafkaConsumer.js";

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? 'rss_fetch_' + env.HOSTNAME : 'rss_fetch_undefined_host' );
const SERVICE_ID: string = 'rss_fetch';

( async (): Promise<void> => {
  // Global logger
  const logger: Logger = new Logger( CLIENT_ID, SERVICE_ID );

  // Redis client
  let redis_client: any;
  try {
    redis_client = createClient({url: 'redis://' + env.REDIS_HOSTNAME + ':' + env.REDIS_PORT});
    await redis_client.connect();
    logger.set_redis_client( redis_client );
  } catch ( err ) {
    console.log( logger.get_log( 'Exception while trying to connect to Redis ' + "\n" + JSON.stringify( err ) ) );
    exit( 1 );
  }

  // Kafka producer
  const kafka_producer: KafkaProducer = new KafkaProducer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID );
  await kafka_producer.connect();
  logger.set_kafka_producer( kafka_producer );

  // Kafka consumer
  const kafka_consumer: KafkaConsumer = new KafkaConsumer( ( env.KAFKA_NODES ? env.KAFKA_NODES.split(',') : [] ), logger, SERVICE_ID );
  await kafka_consumer.connect();

  // create the RSSFetch class instance and run program
  new RSSFetch( kafka_producer, kafka_consumer, logger, redis_client, SERVICE_ID );
})();