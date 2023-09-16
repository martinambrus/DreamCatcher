import {env, exit} from 'node:process';
import { RSSLinksFetch } from "./RSSLinksFetch.js";
import { Logger } from "./Logger.js";
import { ILogger } from './Utils/MQ/KeyStore/Interfaces/ILogger.js';
import { IKeyStoreSub } from './Utils/MQ/KeyStore/Interfaces/IKeyStoreSub.js';
import { KeyStoreSubClient } from './Utils/MQ/KeyStore/KeyStoreSubClient.js';
import { KeyStorePubClient } from './Utils/MQ/KeyStore/KeyStorePubClient.js';
import { IKeyStorePub } from './Utils/MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { IMessageQueuePub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { MessageQueuePub } from './Utils/MQ/MessageQueuePub.js';
import { IMessageQueueSub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { MessageQueueSub } from './Utils/MQ/MessageQueueSub.js';
import { Kafka } from 'kafkajs';
import { Database } from './Utils/Database/Database.js';

// APP settings
const CLIENT_ID: string = ( env.HOSTNAME ? 'rss_links_fetch_' + env.HOSTNAME : 'rss_links_fetch_undefined_host' );
const SERVICE_ID: string = 'rss_links_fetch';

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
    connectionTimeout: 60000,
    authenticationTimeout: 60000,
    requestTimeout: 60000,
  });

  // MQ producer
  const mq_producer: IMessageQueuePub = new MessageQueuePub( connection, logger );
  logger.set_mq_broker( mq_producer );

  // MQ consumer
  const mq_consumer: IMessageQueueSub = new MessageQueueSub( SERVICE_ID, connection, logger );

  // create the RSSFetch class instance and run program
  new RSSLinksFetch( mq_producer, mq_consumer, logger, SERVICE_ID, redis_pub, new Database() );
})();