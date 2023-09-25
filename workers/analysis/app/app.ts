import {env, exit} from 'node:process';
import { Logger } from "./Logger.js";
import { Analysis } from './Analysis.js';
import { ILogger } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IKeyStoreSub } from './MQ/KeyStore/Interfaces/IKeyStoreSub.js';
import { KeyStoreSubClient } from './MQ/KeyStore/KeyStoreSubClient.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { KeyStorePubClient } from './MQ/KeyStore/KeyStorePubClient.js';
import { MessageQueuePub } from './MQ/MessageQueuePub.js';
import { IMessageQueueSub } from './MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { MessageQueueSub } from './MQ/MessageQueueSub.js';
import { Kafka } from 'kafkajs';
import { Database } from './Database/Database.js';

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
    connectionTimeout: 30000,
    authenticationTimeout: 30000,
    requestTimeout: 30000,
  });

  // MQ producer - only for logging purposes in this app
  const mq_producer = new MessageQueuePub( connection, logger );
  mq_producer.set_batch_mode( false );
  logger.set_mq_broker( mq_producer );

  // MQ consumer - new links data
  const mq_consumer: IMessageQueueSub = new MessageQueueSub( SERVICE_ID, connection, logger );

  // create the Analysis class instance and run program
  new Analysis( SERVICE_ID, mq_consumer, logger, new Database(), redis_pub );
})();