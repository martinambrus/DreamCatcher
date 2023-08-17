import { env, exit } from 'node:process';
import { LOG_SEVERITIES, Logger } from './Logger.js';
import pkg from "pg";
import { KafkaProducer } from './KafkaProducer.js';
import { KafkaConsumer } from './KafkaConsumer.js';
import { RedisSubClient } from './RedisSubClient.js';
import { RedisPubClient } from './RedisPubClient.js';
import { Telemetry } from './Telemetry.js';

export class ErrLogWriter {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Main app service ID, so we can use it in Redis logs.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Instance of the Logger class.
   * @private
   * @type { Logger }
   */
  private readonly logger: Logger;

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

    // subscribe to logs channel, so we can store error logs into the DB
    this.kafka_consumer.subscribe( [ this.logs_channel_name ] ).then( async () => {
      // start processing logs
      if ( !await self.kafka_consumer.consume( self.log_error.bind( this ) ) ) {
        let exit_code: number = parseInt( await self.redis_pub.get( 'ERR_RSS_FETCH_KAFKA_NOT_READY' ) );
        await self.logger.log_msg( 'Error while trying to set link parsing function - Kafka Consumer not ready.', exit_code );
        exit( exit_code );
      }

      // publish info about our instance going live
      this.logger.log_msg( self.service_name + ' up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
    });
  }

  /**
   * Logs errors into the database, so they can be browsed easily.
   *
   * @param { Object } data This is the data received from Kafka consumer.
   *                        Object structure: topic, partition, message, heartbeat, pause
   * @private
   */
  private async log_error( { topic, partition, message, heartbeat, pause } ): Promise<void> {
    if ( topic == this.logs_channel_name ) {
      const
        original_msg: string = message.value.toString(),
        trace_id_string: string = message.key.toString();

      message = JSON.parse( original_msg );

      if ( message ) {
        if ( message.severity == LOG_SEVERITIES.LOG_SEVERITY_ERROR ) {
          // try inserting the log data into the DB
          const text: string     = 'INSERT INTO err_log( service_id, code, log_time, msg, extra ) VALUES( $1, $2, $3, $4, $5 ) RETURNING id';
          let values: Array<any> = [ message.service, ( message.code ? message.code : 0 ), message.time, message.msg.replace( /\[[^\]]+\] /gm, '' ) ]; // remove timedate prefix from message

          // check for any extra data in the message and add it to the extra column
          let extra: Object = {};
          for ( let i in message ) {
            if ( ![ 'service', 'code', 'severity', 'time', 'msg' ].includes( i ) ) {
              extra[ i ] = message[ i ];
            }
          }

          values.push( JSON.stringify( extra ) );

          try {
            console.log( this.logger.get_log( 'logging: ' + original_msg ) );
            const res = await this.dbconn.query( text, values );

            if ( !res.rows.length ) {
              console.log( this.logger.get_log( 'Could not insert log into db' ) );
            }
          } catch ( err ) {
            console.log( this.logger.get_log( 'DB error while trying to insert log data:\n' + JSON.stringify( err ) ) );

            // we only log errors where we fail to write a log into the DB,
            // as we're actually logging the error inside of the service where it happened
            // into telemetry
            let trace_carrier: Object;

            // we may receive a non-traceable logs which are not assignable to any single trace
            try {
              trace_carrier = JSON.parse( trace_id_string );
            } catch ( err ) {
              trace_carrier = null;
            }

            const
              error_log_telemetry: Telemetry = await new Telemetry( this.service_name, this.version, this.service_name ).start( trace_carrier ),
              telemetry_name: string = 'error_log';

            await error_log_telemetry.add_span( telemetry_name, {}, 'DB error while trying to insert error log data:\n' + JSON.stringify( err ), 1 );
            error_log_telemetry.close_active_span( telemetry_name );
          }

          // publish to Redis that we're done with tracing
          this.redis_pub.publish( env.REDIS_TELEMETRY_CHANNEL, JSON.stringify( { service: this.service_name, trace_id: trace_id_string } ) );
        }
      } else {
        console.log( this.logger.get_log('Exception while trying to decode and store log data: ' + original_msg ) );
      }
    }
  }
}