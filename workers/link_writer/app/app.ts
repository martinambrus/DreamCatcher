import {env, exit} from 'node:process';
import { Logger } from "./Logger.js";
import { LinkWriter } from "./LinkWriter.js";
import { ILogger } from './Utils/MQ/KeyStore/Interfaces/ILogger.js';
import { KeyStorePubClient } from './Utils/MQ/KeyStore/KeyStorePubClient.js';
import { IKeyStorePub } from './Utils/MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { IMessageQueuePub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { MessageQueuePub } from './Utils/MQ/MessageQueuePub.js';
import { MessageQueueSub } from './Utils/MQ/MessageQueueSub.js';
import { IMessageQueueSub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { Kafka } from 'kafkajs';
import { Database } from './Utils/Database/Database.js';

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? 'link_writer_' + env.HOSTNAME : 'link_writer_undefined_host' );
const SERVICE_ID: string = 'link_writer';

( async (): Promise<void> => {

  // Global logger
  const logger: ILogger = new Logger( CLIENT_ID, SERVICE_ID );

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
    connectionTimeout: 60000,
    authenticationTimeout: 60000,
    requestTimeout: 60000,
  });

  // MQ producer
  const mq_producer: IMessageQueuePub = new MessageQueuePub( connection, logger );
  logger.set_mq_broker( mq_producer );

  // MQ consumer
  const mq_consumer: IMessageQueueSub = new MessageQueueSub( SERVICE_ID, connection, logger );

  // create the LinkWriter class instance and run program
  new LinkWriter( SERVICE_ID, mq_producer, mq_consumer, logger, new Database(), redis_pub);
})();