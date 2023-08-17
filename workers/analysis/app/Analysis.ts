import { env, exit } from 'node:process';
import { LOG_SEVERITIES, Logger } from './Logger.js';
import pkg from "pg";
import { KafkaProducer } from './KafkaProducer.js';
import { KafkaConsumer } from './KafkaConsumer.js';
import { RedisPubClient } from './RedisPubClient.js';
import { RedisSubClient } from './RedisSubClient.js';
import { Telemetry } from './Telemetry.js';

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
   * @type { Logger }
   */
  private readonly logger: Logger;

  /**
   * Main app service ID, so we can use it in Kafka logs.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Kafka logs topic name.
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
   * Instance of the KafkaProducer used for message publishing
   * sections of the code.
   * @private
   * @type { KafkaProducer }
   */
  private readonly kafka_producer: KafkaProducer;

  /**
   * Instance of the KafkaConsumer used to listen
   * for new links data to parse.
   * @private
   * @type { KafkaConsumer }
   */
  private readonly kafka_consumer_links: KafkaConsumer;

  /**
   * Instance of the KafkaConsumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { KafkaConsumer }
   */
  private readonly kafka_consumer_logs: KafkaConsumer;

  /**
   * Redis subscriber client instance,
   * used to subscribe to channels.
   * @type { RedisSubClient }
   * @private
   */
  private readonly redis_sub: RedisSubClient;

  /**
   * Redis publisher and getter client instance,
   * used to fetch error codes.
   * @type { RedisPubClient }
   * @private
   */
  private readonly redis_pub: RedisPubClient;

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
   * An array of error codes loaded from Redis
   * for the RSS fetcher service. This is important
   * because we are monitoring the logs channel
   * for these errors in order to update DB fetch frequency data.
   *
   * @private
   * @type { number }
   */
  private important_rss_fetch_error_codes: Array<number> = [];

  /**
   * Stores references to Redis, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }        service_name         ID of the service from main application for Redis publishing purposes
   * @param { KafkaProducer } kafka_producer       Kafka Producer used to publish messages.
   * @param { KafkaConsumer } kafka_consumer_logs  Kafka Consumer used to listen for RSS feeds to parse.
   * @param { KafkaConsumer } kafka_consumer_links Kafka Consumer used to listen for link data to parse.
   * @param { Logger }        logger               A Logger class instanced used for logging purposes.
   * @param { pkg.Client }    dbconn               A PGSQL client instance.
   * @param { RedisSubClient } redis_sub      A Redis Sub client to subscribe to channels.
   * @param { RedisPubClient } redis_pub      A Redis Pub client to fetch error codes.
   */
  constructor( service_name: string, kafka_producer: KafkaProducer, kafka_consumer_logs: KafkaConsumer, kafka_consumer_links: KafkaConsumer, logger: Logger, dbconn: pkg.Client, redis_sub: RedisSubClient, redis_pub: RedisPubClient ) {
    // Kafka
    this.kafka_producer = kafka_producer;
    this.kafka_consumer_logs = kafka_consumer_logs;
    this.kafka_consumer_links = kafka_consumer_links;

    // Logger
    this.logger = logger;

    // Database
    this.dbconn = dbconn;

    // Redis
    this.redis_sub = redis_sub;
    this.redis_pub = redis_pub;

    // strings
    this.service_name = service_name;
    this.logs_channel_name = env.KAFKA_LOGS_CHANNEL;
    this.links_channel_name = env.KAFKA_NEW_LINKS_CHANNEL;

    let self = this;

    // load all error codes for which we want to increment number of errors per feed
    ( async (): Promise<void> => {
      for (let err_code_string of ['ERR_RSS_FETCH_INVALID_JSON_FEED', 'ERR_RSS_FETCH_PROCESSING', 'ERR_RSS_FETCH_TIMEOUT', 'ERR_RSS_FETCH_WRONG_URL_CANNOT_FIX']) {
        self.important_rss_fetch_error_codes.push( parseInt( await self.redis_pub.get( err_code_string ) ) );
      }
    })();

    // create a task that will update this service active status every minute
    setInterval( (): void => {
      if ( self.kafka_consumer_logs.get_active() && self.kafka_consumer_links.get_active() && self.kafka_producer.get_active() ) {
        self.redis_pub.set( self.service_name + '_active', 1 );
      }
    }, 60000 );

    // mark ourselves as active from the start, if both - producer and consumer - are active
    if ( self.kafka_consumer_logs.get_active() && self.kafka_consumer_links.get_active() && self.kafka_producer.get_active() ) {
      this.redis_pub.set( this.service_name + '_active', 1 );
    }

    // subscribe to RSS new links channel, so we can update statistics for links amount per day, month and year
    // once the link writer publishes its new links counter
    this.kafka_consumer_links.subscribe( [ this.links_channel_name ] ).then( async () => {
      // start processing links data for analytical purposes
      if ( !await self.kafka_consumer_links.consume( self.update_ok_stats.bind( this ) ) ) {
        let exit_code: number = parseInt( await self.redis_pub.get( 'ERR_RSS_FETCH_KAFKA_NOT_READY' ) );
        await self.logger.log_msg( 'Error while trying to set link parsing function - Kafka Consumer not ready.', exit_code );
        exit( exit_code );
      }
    });

    // subscribe to RSS fetch errors, so we can update DB stats with error data
    this.kafka_consumer_logs.subscribe( [ this.logs_channel_name ] ).then( async () => {
      // start processing logs for analytical purposes
      if ( !await self.kafka_consumer_logs.consume( self.update_error_stats.bind( this ) ) ) {
        let exit_code: number = parseInt( await self.redis_pub.get( 'ERR_RSS_FETCH_KAFKA_NOT_READY' ) );
        await self.logger.log_msg( 'Error while trying to set link parsing function - Kafka Consumer not ready.', exit_code );
        exit( exit_code );
      }

      // publish info about our instance going live
      this.logger.log_msg( self.service_name + ' up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
    });
  }

  /**
   * Updates statistics when RSS feed fetch was successful.
   *
   * @param { Object } data This is the data received from Kafka consumer.
   *                        Object structure: topic, partition, message, heartbeat, pause
   * @private
   */
  private async update_ok_stats( { topic, partition, message, heartbeat, pause } ): Promise<void> {
    if ( topic == this.links_channel_name ) {
      const
        original_msg: string = message.value.toString(),
        trace_id_string: string = message.key.toString();

      message = JSON.parse( original_msg );

      if ( message ) {
        // check that we have the right message
        if ( message.service == 'link_writer' && message.severity == LOG_SEVERITIES.LOG_SEVERIRY_NOTICE ) {
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
            trace_carrier = JSON.parse( trace_id_string );
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
            this.logger.log_msg('Exception while trying to save statistical feed data of ' + message.extra_data.feed_url + '\n' + err.message + '\ndata: ' + original_msg, 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' );
            if ( analysis_telemetry !== null ) {
              await analysis_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Exception while trying to save statistical feed data of ' + message.extra_data.feed_url + '\n' + err.message + '\ndata: ' + original_msg, 1 );
              analysis_telemetry.close_active_span( telemetry_name );
            }
          }

          // publish to Redis that we're done with tracing
          this.redis_pub.publish( env.REDIS_TELEMETRY_CHANNEL, JSON.stringify( { service: this.service_name, trace_id: trace_id_string } ) );
        }
      } else {
        // no await - if this message is not stored, we'll see this in telemetry
        this.logger.log_msg('Exception while trying to decode Link Writer log data: ' + original_msg, 'ERR_LINK_WRITER_INVALID_LOG_MSG' );
      }
    }
  }

  /**
   * Updates statistics when RSS feed fetch was unsuccessful.
   *
   * @param { Object } data This is the data received from Kafka consumer.
   *                        Object structure: topic, partition, message, heartbeat, pause
   * @private
   */
  private async update_error_stats( { topic, partition, message, heartbeat, pause } ): Promise<void> {
    if ( topic == this.logs_channel_name ) {
      const
        original_msg: string = message.value.toString(),
        trace_id_string: string = message.key.toString();

      message = JSON.parse( original_msg );

      if ( message ) {
        // check that we have the right message
        if ( message.service == 'rss_fetch' && this.important_rss_fetch_error_codes.includes( parseInt( message.code ) ) ) {
          let trace_carrier: Object;

          // we may receive a non-traceable logs which are not assignable to any single trace
          try {
            trace_carrier = JSON.parse( trace_id_string );
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
            this.logger.log_msg('Exception while trying to update feed fetch data of ' + message.msg.feed_url + '\n' + JSON.stringify( err ) + '\ndata: ' + original_msg, 'ERR_ANALYSIS_FEED_FREQUENCY_UPDATE_FAILURE' );
            if ( analysis_telemetry !== null ) {
              await analysis_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Exception while trying to update feed fetch data of ' + message.msg.feed_url + '\n' + JSON.stringify( err ) + '\ndata: ' + original_msg, 1 );
              analysis_telemetry.close_active_span( telemetry_name );
            }
          }

          // publish to Redis that we're done with tracing
          this.redis_pub.publish( env.REDIS_TELEMETRY_CHANNEL, JSON.stringify( { service: this.service_name, trace_id: trace_id_string } ) );
        }
      } else {
        // no await - if this message is not stored, we'll see this in telemetry
        this.logger.log_msg('Exception while trying to decode RSS Fetch log data: ' + original_msg, 'ERR_RSS_FETCH_INVALID_LOG_MSG' );
      }
    }
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