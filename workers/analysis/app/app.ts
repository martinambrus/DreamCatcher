import {env, exit} from 'node:process';
import { Logger } from "./Logger.js";
import { Analysis } from './Analysis.js';
import pkg from 'pg';
import { ILogger } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IKeyStoreSub } from './MQ/KeyStore/Interfaces/IKeyStoreSub.js';
import { KeyStoreSubClient } from './MQ/KeyStore/KeyStoreSubClient.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { KeyStorePubClient } from './MQ/KeyStore/KeyStorePubClient.js';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { MessageQueuePub } from './MQ/MessageQueuePub.js';
import { IMessageQueueSub } from './MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { MessageQueueSub } from './MQ/MessageQueueSub.js';
import { log } from 'util';
import { Kafka } from 'kafkajs';

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
  const logger: ILogger = new Logger( CLIENT_ID, SERVICE_ID );

  // Redis Sub client
  let redis_sub: IKeyStoreSub = new KeyStoreSubClient( logger );
  await redis_sub.connect( env.KEY_STORE_NODES, env.KEY_STORE_PORT );

  // Redis Pub client
  let redis_pub: IKeyStorePub = new KeyStorePubClient( logger );
  await redis_pub.connect( env.KEY_STORE_NODES, env.KEY_STORE_PORT );
  logger.set_key_store_pub_client( redis_pub );

  // check for a valid brokers array
  const brokers = ( env.MQ_NODES ? env.MQ_NODES.split(',') : [] );
  if ( brokers.length == 1 && brokers[ 0 ] == '' ) {
    // we're most probably missing missing an ENV key
    console.log( logger.format( 'Brokers missing for Kafka! Received: ' + brokers.toString() ) );
    exit( 1 );
  }

  console.log( logger.format( 'Creating Kafka client to connect to the following brokers: ' + brokers.toString() ) );

  const connection = new Kafka({
    clientId: SERVICE_ID,
    brokers: brokers,
  });

  // MQ producer
  const mq_producer: IMessageQueuePub = new MessageQueuePub( connection, logger );
  logger.set_mq_broker( mq_producer );

  // MQ consumer - new links data
  const mq_consumer: IMessageQueueSub = new MessageQueueSub( SERVICE_ID, connection, logger );

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
  new Analysis( SERVICE_ID, mq_producer, mq_consumer, logger, dbconn, redis_pub );
})();