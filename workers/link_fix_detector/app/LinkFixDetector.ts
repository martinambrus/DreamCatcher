import { env, exit } from 'node:process';
import { LOG_SEVERITIES, Logger } from './Logger.js';
import pkg from "pg";
import { KafkaProducer } from './KafkaProducer.js';
import { KafkaConsumer } from './KafkaConsumer.js';
import { RedisSubClient } from './RedisSubClient.js';
import { RedisPubClient } from './RedisPubClient.js';
import { Telemetry } from './Telemetry.js';

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
   * Instance of the KafkaProducer used for message publishing
   * sections of the code.
   * @private
   * @type { KafkaProducer }
   */
  private readonly kafka_producer: KafkaProducer;

  /**
   * Instance of the KafkaConsumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { KafkaConsumer }
   */
  private readonly kafka_consumer: KafkaConsumer;

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
   * Error code to check for when receiving Kafka log messages,
   * so we know which error message to react to and when to rewrite
   * an invalid feed URL.
   * @private
   * @type { number }
   */
  private redis_wrong_link_err_code: number;

  /**
   * Stores references to Redis, PGSQL and Logger classes
   * that were created outside of this main class.
   *
   * @param { string }        service_name   ID of the service from main application for Redis publishing purposes
   * @param { KafkaProducer } kafka_producer Kafka Producer used to publish messages.
   * @param { KafkaConsumer } kafka_consumer Kafka Consumer used to listen for links data to parse.
   * @param { Logger }        logger A Logger class instanced used for logging purposes.
   * @param { pkg.Client }    dbconn A PGSQL client instance.
   * @param { RedisSubClient } redis_sub      A Redis Sub client to subscribe to channels.
   * @param { RedisPubClient } redis_pub      A Redis Pub client to fetch error codes.
   */
  constructor( service_name: string, kafka_producer: KafkaProducer, kafka_consumer: KafkaConsumer, logger: Logger, dbconn: pkg.Client, redis_sub: RedisSubClient, redis_pub: RedisPubClient ) {
    // Kafka
    this.kafka_producer = kafka_producer;
    this.kafka_consumer = kafka_consumer;

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

    let self = this;

    // create a task that will update this service active status every minute
    setInterval( (): void => {
      if ( self.kafka_consumer.get_active() && self.kafka_producer.get_active() ) {
        self.redis_pub.set( self.service_name + '_active', 1 );
      }
    }, 60000 );

    // mark ourselves as active from the start, if both - producer and consumer - are active
    if ( this.kafka_consumer.get_active() && this.kafka_producer.get_active() ) {
      this.redis_pub.set( this.service_name + '_active', 1 );
    }

    // subscribe to RSS new links channel, so we can update wrong feed links when they are found
    this.kafka_consumer.subscribe( [ this.logs_channel_name ] ).then( async () => {
      // store redis error code
      self.redis_wrong_link_err_code = parseInt( await self.redis_pub.get( 'ERR_RSS_FETCH_WRONG_URL' ) );

      // start processing newfound links
      if ( !await self.kafka_consumer.consume( self.db_update_wrong_feed_url.bind( this ) ) ) {
        let exit_code: number = parseInt( await self.redis_pub.get( 'ERR_RSS_FETCH_KAFKA_NOT_READY' ) );
        await self.logger.log_msg( 'Error while trying to set link parsing function - Kafka Consumer not ready.', exit_code );
        exit( exit_code );
      }

      // publish info about our instance going live
      this.logger.log_msg( self.service_name + ' up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
    });
  }

  /**
   * Rewrites invalid feed URL to a valid one in the database.
   *
   * @param { Object } data This is the data received from Kafka consumer.
   *                        Object structure: topic, partition, message, heartbeat, pause
   * @private
   */
  private async db_update_wrong_feed_url( { topic, partition, message, heartbeat, pause } ): Promise<void> {
    if ( topic == this.logs_channel_name ) {
      const
        original_msg: string = message.value.toString(),
        trace_id_string: string = message.key.toString();

      message = JSON.parse( original_msg );

      if ( message ) {
        // check that we have the right message
        if ( message.service.indexOf( 'rss_fetch' ) > -1 && message.severity == LOG_SEVERITIES.LOG_SEVERITY_NOTICE && message.code == this.redis_wrong_link_err_code ) {
          let trace_carrier: Object;

          // we may receive a non-traceable logs which are not assignable to any single trace
          try {
            trace_carrier = JSON.parse( trace_id_string );
          } catch ( err ) {
            trace_carrier = null;
          }

          const
            url_fix_telemetry: Telemetry = ( trace_carrier !== null ? await new Telemetry( this.service_name, this.version, message.extra_data.feed_url ).start( trace_carrier ) : null ),
            telemetry_name: string = 'rss_feed_url_fix';

          try {
            if ( url_fix_telemetry !== null ) {
              await url_fix_telemetry.add_span( telemetry_name, { 'old_feed_url' : message.extra_data.old_feed_url, 'feed_url' : message.extra_data.feed_url } );
            }

            console.log( this.logger.get_log( 'updating feed URL for feed ' + message.extra_data.old_feed_url + ' to ' + message.extra_data.feed_url ) );
            this.dbconn.query( 'UPDATE feeds SET url = $1 WHERE url = $2', [ message.extra_data.feed_url, message.extra_data.old_feed_url ] );

            if ( url_fix_telemetry !== null ) {
              url_fix_telemetry.close_active_span( telemetry_name );
            }
          } catch ( err ) {
            // no await - if this message is not stored, we'll see this in telemetry
            this.logger.log_msg( 'Exception while trying to update feed URL for ' + message.extra_data.old_feed_url + '\n' + JSON.stringify( err ), 'ERR_INVALID_FEED_URL_UPDATE_FAILURE' );
            if ( url_fix_telemetry !== null ) {
              await url_fix_telemetry.add_span( telemetry_name, { 'feed_url': message.extra_data.feed_url }, 'Exception while trying to update feed URL for ' + message.extra_data.old_feed_url + '\n' + JSON.stringify( err ), 1 );
              url_fix_telemetry.close_active_span( telemetry_name );
            }
          }

          // publish to Redis that we're done with tracing
          this.redis_pub.publish( env.REDIS_TELEMETRY_CHANNEL, JSON.stringify( { service: this.service_name, trace_id: trace_id_string } ) );
        }
      } else {
        // no await - if this message is not stored, we'll see this in telemetry
        this.logger.log_msg('Exception while trying to decode log data: ' + original_msg, 'ERR_LOG_MESSAGE_INVALID' );
      }
    }
  }
}