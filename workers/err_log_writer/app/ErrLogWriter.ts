import { env, exit } from 'node:process';
import { Telemetry } from './Telemetry.js';
import { IKeyStoreSub } from './MQ/KeyStore/Interfaces/IKeyStoreSub.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { ILogger, LOG_SEVERITIES } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { IMessageQueueSub } from './MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import { IDatabase } from './Database/Interfaces/IDatabase.js';

export class ErrLogWriter {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Main app service ID, so we can use it in key store logs.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Instance of the Logger class.
   * @private
   * @type { ILogger }
   */
  private readonly logger: ILogger;

  /**
   * MQ logs topic name.
   * @private
   * @type { string }
   */
  private readonly logs_channel_name: string;

  /**
   * Instance of the MQ Producer used for message publishing
   * sections of the code.
   * @private
   * @type { IMessageQueuePub }
   */
  private readonly mq_producer: IMessageQueuePub;

  /**
   * Instance of the MQ Consumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { IMessageQueueSub }
   */
  private readonly mq_consumer: IMessageQueueSub;

  /**
   * Key store subscriber client instance,
   * used to subscribe to channels.
   * @type { IKeyStoreSub }
   * @private
   */
  private readonly key_store_sub: IKeyStoreSub;

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
   * @type { IDatabase }
   */
  private readonly dbconn: IDatabase;

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }           service_name  ID of the service from main application for key store publishing purposes
   * @param { IMessageQueuePub } mq_producer   MQ Producer used to publish messages.
   * @param { IMessageQueueSub } mq_consumer   MQ Consumer used to listen for links data to parse.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { IDatabase }        dbconn        A Database class instance.
   * @param { IKeyStoreSub }     key_store_sub A Key Store Sub client to subscribe to channels.
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   */
  constructor( service_name: string, mq_producer: IMessageQueuePub, mq_consumer: IMessageQueueSub, logger: ILogger, dbconn: IDatabase, key_store_sub: IKeyStoreSub, key_store_pub: IKeyStorePub ) {
    // MQ
    this.mq_producer = mq_producer;
    this.mq_consumer = mq_consumer;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // key store
    this.key_store_sub = key_store_sub;
    this.key_store_pub = key_store_pub;

    // strings
    this.service_name = service_name;
    this.logs_channel_name = env.LOGS_CHANNEL_NAME;

    // publish info about our instance going live
    this.logger.log_msg( 'err_log_writer up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // create a task that will update this service active status every minute
    // ... this is here in case Redis goes down, so we can show that we are alive again
    setInterval( (): void => {
      self.key_store_pub.set( self.service_name + '_active', 1 );
    }, 60000 );

    // subscribe to logs channel, so we can store error logs into the DB
    this.mq_consumer.consume( this.logs_channel_name, self.log_error.bind( this ) );
  }

  /**
   * Logs errors into the database, so they can be browsed easily.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async log_error( { topic, message, trace_id } ): Promise<void> {
    if ( message.severity == LOG_SEVERITIES.LOG_SEVERITY_ERROR ) {
      // check for any extra data in the message and add it to the extra column
      let extra: Object = {};
      for ( let i in message ) {
        if ( ![ 'service', 'code', 'severity', 'time', 'msg' ].includes( i ) ) {
          extra[ i ] = message[ i ];
        }
      }

      try {
        console.log( this.logger.format( 'logging: ' + JSON.stringify( message ) ) );
        await this.dbconn.log_error( message.service, ( message.code ? message.code : 0 ), message.time, message.msg.replace( /\[[^\]]+\] /gm, '' ), JSON.stringify( extra ) );
      } catch ( err ) {
        console.log( this.logger.format( 'DB error while trying to insert log data:\n' + JSON.stringify( err ) ) );

        // we only log errors where we fail to write a log into the DB,
        // as we're actually logging the error inside of the service where it happened
        // into telemetry
        let trace_carrier: Object;

        // we may receive a non-traceable logs which are not assignable to any single trace
        try {
          trace_carrier = JSON.parse( trace_id );
        } catch ( err ) {
          trace_carrier = null;
        }

        const
          error_log_telemetry: Telemetry = await new Telemetry( this.service_name, this.version, this.service_name ).start( trace_carrier ),
          telemetry_name: string = 'error_log';

        await error_log_telemetry.add_span( telemetry_name, {}, 'DB error while trying to insert error log data:\n' + JSON.stringify( err ), 1 );
        error_log_telemetry.close_active_span( telemetry_name );
      }

      // publish to key store that we're done with tracing
      this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_name, trace_id: trace_id } ) );
    }
  }
}