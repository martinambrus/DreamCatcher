import { env, exit } from 'node:process';
import pkg from "pg";
import { Telemetry } from './Telemetry.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { ILogger, LOG_SEVERITIES } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IMessageQueueSub } from './MQ/KeyStore/Interfaces/IMessageQueueSub.js';

export class LinkFixDetector {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Instance of the Logger class.
   * @private
   * @type { ILogger }
   */
  private readonly logger: ILogger;

  /**
   * Main app service ID, so we can use it in MQ logs.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Instance of the MQ Consumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { IMessageQueueSub }
   */
  private readonly mq_consumer: IMessageQueueSub;

  /**
   * Key store publisher and getter client instance,
   * used to fetch error codes.
   * @type { IKeyStorePub }
   * @private
   */
  private readonly key_store_pub: IKeyStorePub;

  /**
   * PostgreSQL client class instance.
   * @private
   * @type { pkg.Client }
   */
  private readonly dbconn: pkg.Client;

  /**
   * Error code to check for when receiving message queue broker log messages,
   * so we know which error message to react to and when to rewrite
   * an invalid feed URL.
   * @private
   * @type { number }
   */
  private key_store_wrong_link_err_code: number;

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }           service_name  ID of the service from main application for key store publishing purposes
   * @param { IMessageQueueSub } mq_consumer   MQ Consumer used to listen for links data to parse.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { pkg.Client }       dbconn        A PGSQL client instance.
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   */
  constructor( service_name: string, mq_consumer: IMessageQueueSub, logger: ILogger, dbconn: pkg.Client, key_store_pub: IKeyStorePub ) {
    // MQ
    this.mq_consumer = mq_consumer;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // key store
    this.key_store_pub = key_store_pub;

    // strings
    this.service_name = service_name;

    // publish info about our instance going live
    this.logger.log_msg( 'link_fix_detector up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // create a task that will update this service active status every minute
    // ... this is here in case Redis goes down, so we can show that we are alive again
    setInterval( (): void => {
      self.key_store_pub.set( self.service_name + '_active', 1 );
    }, 60000 );

    // mark ourselves as active
    this.key_store_pub.set( this.service_name + '_active', 1 );

    // subscribe to RSS invalid links channel, so we can update wrong feed links when they are found
    this.mq_consumer.consume( env.RSS_INVALID_URLS_CHANEL_NAME, self.db_update_wrong_feed_url.bind( this ) );
  }

  /**
   * Rewrites invalid feed URL to a valid one in the database.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async db_update_wrong_feed_url( { topic, message, trace_id } ): Promise<void> {
    let trace_carrier: Object;

    // we may receive a non-traceable logs which are not assignable to any single trace
    try {
      trace_carrier = JSON.parse( trace_id );
    } catch ( err ) {
      trace_carrier = null;
    }

    const
      url_fix_telemetry: Telemetry = ( trace_carrier !== null ? await new Telemetry( this.service_name, this.version, message.feed_url ).start( trace_carrier ) : null ),
      telemetry_name: string = 'rss_feed_url_fix';

    try {
      if ( url_fix_telemetry !== null ) {
        await url_fix_telemetry.add_span( telemetry_name, { 'old_feed_url' : message.old_feed_url, 'feed_url' : message.feed_url } );
      }

      console.log( this.logger.format( 'updating feed URL for feed ' + message.old_feed_url + ' to ' + message.feed_url ) );
      this.dbconn.query( 'UPDATE feeds SET url = $1 WHERE url = $2', [ message.feed_url, message.old_feed_url ] );

      if ( url_fix_telemetry !== null ) {
        url_fix_telemetry.close_active_span( telemetry_name );
      }
    } catch ( err ) {
      // no await - if this message is not stored, we'll see this in telemetry
      this.logger.log_msg( 'Exception while trying to update feed URL for ' + message.old_feed_url + '\n' + JSON.stringify( err ), 'ERR_INVALID_FEED_URL_UPDATE_FAILURE' );
      if ( url_fix_telemetry !== null ) {
        await url_fix_telemetry.add_span( telemetry_name, { 'feed_url': message.feed_url }, 'Exception while trying to update feed URL for ' + message.old_feed_url + '\n' + JSON.stringify( err ), 1 );
        url_fix_telemetry.close_active_span( telemetry_name );
      }
    }

    // publish to key store that we're done with tracing
    this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_name, trace_id: trace_id } ) );
  }
}