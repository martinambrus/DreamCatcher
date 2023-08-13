import {env, exit} from 'node:process';
import { Logger } from "./Logger.js";
import { KafkaProducer } from "./KafkaProducer.js";
import { ControlCenter } from "./ControlCenter.js";
import { createClient } from "redis";
import pkg from 'pg';

const { Client } = pkg;

// PGSQL settings
const POSTGRES_HOST: string = env.POSTGRES_HOST;
const POSTGRES_USER: string = env.POSTGRES_USER;
const POSTGRES_PASSWORD: string = env.POSTGRES_PASSWORD;
const POSTGRES_DB: string = env.POSTGRES_DB;

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? env.HOSTNAME : 'control_center_undefined_host' );
const SERVICE_ID: string = 'control_center';

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

  // PGSQL class instance
  const dbconn: pkg.Client = new Client({
    host: POSTGRES_HOST,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DB
  });

  // try connecting to PGSQL
  if (!POSTGRES_DB || !POSTGRES_PASSWORD || !POSTGRES_USER) {
    let exit_code: number = parseInt( await redis_client.get( 'ERR_POSTGRES_MISSING_CONNECTION_DATA' ) );
    logger.log_msg( 'missing one of POSTGRES environment variables', exit_code );
    exit( exit_code );
  } else {
    // try to connect to PGSQL
    try {
      await dbconn.connect();
    } catch (err) {
      let exit_code: number = parseInt( await redis_client.get( 'ERR_POSTGRES_CANNOT_CONNECT' ) );
      logger.log_msg( 'could not connect to POSTGRES\n' + JSON.stringify( err ), exit_code );
      exit( exit_code );
    }
  }

  // create the ControlCenter class instance and run program
  new ControlCenter( kafka_producer, logger, dbconn, redis_client );
})();