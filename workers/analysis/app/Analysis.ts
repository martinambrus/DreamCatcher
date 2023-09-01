import { env, exit } from 'node:process';
import pkg from "pg";
import { Telemetry } from './Telemetry.js';
import { ILogger, LOG_SEVERITIES } from './MQ/KeyStore/Interfaces/ILogger.js';
import { IKeyStorePub } from './MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { IMessageQueuePub } from './MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { IMessageQueueSub } from './MQ/KeyStore/Interfaces/IMessageQueueSub.js';

export class Analysis {

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
   * Main app service ID, so we can use it in logs.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * MQ logs topic name.
   * @private
   * @type { string }
   */
  private readonly logs_channel_name: string;

  /**
   * New ilnks channel name.
   * @private
   * @type { string }
   */
  private links_channel_name: string;

  /**
   * Instance of the MQ used for message publishing
   * sections of the code.
   * @private
   * @type { IMessageQueuePub }
   */
  private readonly mq_producer: IMessageQueuePub;

  /**
   * Instance of the MQ used to listen
   * for RSS feeds and links to parse.
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
   * Statistical object for PGSQL prepared statements updating feed stats and fetch times
   * upon successfully finished RSS fetch.
   * @private
   * @type { object }
   */
  private inc_stats_and_fetch_times: { name: string, text: string } = {
    name: 'update_feed_data',
    text: 'SELECT update_feed_after_fetch_success( $1, $2, $3, $4, $5, $6, $7, $8, $9 )',
  };

  /**
   * Statistical object for PGSQL prepared statements updating fetch times only
   * upon unsuccessful RSS fetch.
   * @private
   * @type { object }
   */
  private inc_fetch_times_only: { name: string, text: string } = {
    name: 'update_feed_fetch_times',
    text: 'SELECT update_feed_after_fetch_failed( $1, $2 )',
  };

  /**
   * An array of error codes loaded from key store
   * for the RSS fetcher service. This is important
   * because we are monitoring the logs channel
   * for these errors in order to update DB fetch frequency data.
   *
   * @private
   * @type { number }
   */
  private important_rss_fetch_error_codes: Array<number> = [];

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }           service_name  ID of the service from main application for key store publishing purposes
   * @param { IMessageQueuePub } mq_producer   MQ Producer used to publish messages.
   * @param { IMessageQueueSub } mq_consumer   MQ Consumer used to listen for RSS feeds and links to parse.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { pkg.Client }       dbconn        A PGSQL client instance.
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   */
  constructor( service_name: string, mq_producer: IMessageQueuePub, mq_consumer: IMessageQueueSub, logger: ILogger, dbconn: pkg.Client, key_store_pub: IKeyStorePub ) {
    // MQ
    this.mq_producer = mq_producer;
    this.mq_consumer = mq_consumer;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // Key Store
    this.key_store_pub = key_store_pub;

    // strings
    this.service_name = service_name;
    this.logs_channel_name = env.LOGS_CHANNEL_NAME;
    this.links_channel_name = env.NEW_LINKS_CHANNEL_NAME;

    // publish info about our instance going live
    this.logger.log_msg( 'analysis up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // load all error codes for which we want to increment number of errors per feed
    ( async (): Promise<void> => {
      for (let err_code_string of ['ERR_RSS_FETCH_INVALID_JSON_FEED', 'ERR_RSS_FETCH_PROCESSING', 'ERR_RSS_FETCH_TIMEOUT', 'ERR_RSS_FETCH_WRONG_URL_CANNOT_FIX']) {
        self.important_rss_fetch_error_codes.push( parseInt( await self.key_store_pub.get( err_code_string ) ) );
      }
    })();

    // create a task that will update this service active status every minute
    // ... this is here in case Redis goes down, so we can show that we are alive again
    setInterval( (): void => {
      self.key_store_pub.set( self.service_name + '_active', 1 );
    }, 60000 );

    // mark ourselves as active in the key store
    this.key_store_pub.set( this.service_name + '_active', 1 );

    // subscribe to RSS new links channel, so we can update statistics for links amount per day, month and year
    // once the link writer publishes its new links counter
    // ... also, subscribe to RSS fetch errors, so we can update DB stats with error data
    this.mq_consumer.consume( [ this.links_channel_name, this.logs_channel_name ], self.update_stats.bind( this ) );
  }

  /**
   * A semaphore method, calling the right sub-method
   * to process analytics based on the data received.
   *
   * This is here, so we don't have to use 2 consumers.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async update_stats( { topic, message, trace_id } ): Promise<any> {
    if ( topic == this.logs_channel_name ) {
      if ( message.service == 'link_writer' && message.severity == LOG_SEVERITIES.LOG_SEVERITY_NOTICE ) {
        await this.update_ok_stats( { topic: topic, message: message, trace_id: trace_id } );
      }
    } else if ( topic == this.links_channel_name ) {
      if ( message.service == 'rss_fetch' && this.important_rss_fetch_error_codes.includes( parseInt( message.code ) ) ) {
        await this.update_error_stats( { topic: topic, message: message, trace_id: trace_id } );
      }
    }
  }

  /**
   * Updates statistics when RSS feed fetch was successful.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async update_ok_stats( { topic, message, trace_id } ): Promise<any> {
    let dt: Date = new Date();

    if ( !message.extra_data.links_count ) {
      message.extra_data.links_count = 0;
    }

    if ( !message.extra_data.first_item_ts ) {
      message.extra_data.first_item_ts = Math.round( Date.now() / 1000 );
    }

    let trace_carrier: Object;

    // we may receive a non-traceable logs which are not assignable to any single trace
    try {
      trace_carrier = JSON.parse( trace_id );
    } catch ( err ) {
      trace_carrier = null;
    }

    const
      analysis_telemetry: Telemetry = ( trace_carrier !== null ? await new Telemetry( this.service_name, this.version, message.extra_data.feed_url ).start( trace_carrier ) : null ),
      telemetry_name: string = 'analysis_update';

    try {
      if ( analysis_telemetry !== null ) {
        await analysis_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Fetch successful' );
      }

      // no need to await for this log message, since we only debug-log it
      //this.logger.log_msg( 'writing stats data and updating fetch times for ' + message.extra_data.feed_url, 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
      this.inc_stats_and_fetch_times[ 'values' ] = [ message.extra_data.feed_url, dt.getHours(), dt.getDay(), this.daysIntoYear(dt), this.weekIntoYear( dt ), ( dt.getMonth() + 1 ), dt.getFullYear(), message.extra_data.links_count, message.extra_data.first_item_ts ];
      this.dbconn.query( this.inc_stats_and_fetch_times );

      if ( analysis_telemetry !== null ) {
        analysis_telemetry.close_active_span( telemetry_name );
      }
    } catch ( err ) {
      // no await - if this message is not stored, we'll see this in telemetry
      this.logger.log_msg('Exception while trying to save statistical feed data of ' + message.extra_data.feed_url + '\n' + err.message + '\ndata: ' + JSON.stringify( message ), 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' );
      if ( analysis_telemetry !== null ) {
        await analysis_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Exception while trying to save statistical feed data of ' + message.extra_data.feed_url + '\n' + err.message + '\ndata: ' + JSON.stringify( message ), 1 );
        analysis_telemetry.close_active_span( telemetry_name );
      }
    }

    // publish to key store that we're done with tracing
    this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_name, trace_id: trace_id } ) );
  }

  /**
   * Updates statistics when RSS feed fetch was unsuccessful.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async update_error_stats( { topic, message, trace_id } ): Promise<any> {
    let trace_carrier: Object;

    // we may receive a non-traceable logs which are not assignable to any single trace
    try {
      trace_carrier = JSON.parse( trace_id );
    } catch ( err ) {
      trace_carrier = null;
    }

    const
      analysis_telemetry: Telemetry = ( trace_carrier !== null ? await new Telemetry( this.service_name, this.version, message.extra_data.feed_url ).start( trace_carrier ) : null ),
      telemetry_name: string = 'analysis_update';

    try {
      if ( analysis_telemetry !== null ) {
        await analysis_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Fetch failed' );
      }

      // no need to wait for this log
      //this.logger.log_msg( 'updating fetch times for failed fetch of ' + message.extra_data.feed_url, 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
      this.inc_fetch_times_only[ 'values' ] = [ message.extra_data.feed_url, message.msg ];
      this.dbconn.query( this.inc_fetch_times_only );

      if ( analysis_telemetry !== null ) {
        analysis_telemetry.close_active_span( telemetry_name );
      }
    } catch ( err ) {
      // no await - if this message is not stored, we'll see this in telemetry
      this.logger.log_msg('Exception while trying to update feed fetch data of ' + message.msg.feed_url + '\n' + JSON.stringify( err ) + '\ndata: ' + JSON.stringify( message ), 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' );
      if ( analysis_telemetry !== null ) {
        await analysis_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Exception while trying to update feed fetch data of ' + message.msg.feed_url + '\n' + JSON.stringify( err ) + '\ndata: ' + JSON.stringify( message ), 1 );
        analysis_telemetry.close_active_span( telemetry_name );
      }
    }

    // publish to key store that we're done with tracing
    this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_name, trace_id: trace_id } ) );
  }

  /**
   * Returns the number of current day in the given date's year.
   *
   * @param   { Date } date The date from which to calculate the day number.
   * @private
   *
   * @return { number } Returns the number of current day in this year.
   */
  private daysIntoYear( date: globalThis.Date ): number {
    return ( Date.UTC( date.getFullYear(), date.getMonth(), date.getDate() ) - Date.UTC( date.getFullYear(), 0, 0 ) ) / 24 / 60 / 60 / 1000;
  }

  /**
   * Returns number of week into the given date's year.
   *
   * @param { Date } date Date from which to calculate number of weeks.
   * @private
   *
   * @return Returns number of week into the given date's year.
   */
  private weekIntoYear( date: globalThis.Date ): number {
    date.setHours(0, 0, 0, 0);

    // Thursday in current week decides the year.
    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);

    // January 4 is always in week 1.
    let week1: Date = new Date(date.getFullYear(), 0, 4);

    // Adjust to Thursday in week 1 and count number of weeks from date to week1.
    return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  }
}