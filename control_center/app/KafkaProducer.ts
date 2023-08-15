import { env, exit } from 'node:process';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { Logger } from "./Logger.js";

export class KafkaProducer {

  /**
   * Kafka client
   * @type { Kafka }
   * @private
   */
  private client: Kafka;

  /**
   * Identification for this Kafka producer.
   * @type { string }
   * @private
   */
  private client_id: string;

  /**
   * Kafka producer
   * @type { any }
   * @private
   */
  private producer: Producer;

  /**
   * New links channel name.
   * @private
   */
  private new_links_channel_name: string;

  /**
   * Feeds fetch channel name.
   * @private
   */
  private feed_fetch_channel_name: string;

  /**
   * Logs channel name.
   * @private
   */
  private logs_channel_name: string;

  /**
   * Determines whether the Kafka client was successfully connected.
   * @type { boolean }
   * @private
   */
  private ready: boolean = false;

  /**
   * A logger class instance.
   * @type { Logger }
   * @private
   */
  private logger: Logger;

  /**
   * Defines internal Kafka setup and creates a Kafka client
   * based off the brokers data received.
   *
   * @param { Array<string> } brokers   List of all Kafka brokers to be aware of.
   * @param { Logger }        logger    Log writer and sender.
   * @param { string }        client_id ID of the client that uniquely identifies this Kafka producer.
   *
   * @constructor
   */
  constructor( brokers: Array<string>, logger: Logger, client_id: string ) {
    // check for a valid brokers array
    if ( brokers.length == 1 && brokers[ 0 ] == '' ) {
      // we're most probably missing missing an ENV key
      console.log( logger.get_log( 'Brokers missing for Kafka Producer! Received: ' + brokers.toString() ) );
      exit( 1 );
    }

    this.new_links_channel_name = env.KAFKA_NEW_LINKS_CHANNEL;
    this.logs_channel_name = env.KAFKA_LOGS_CHANNEL;
    this.feed_fetch_channel_name = env.KAFKA_FEED_FETCH_CHANNEL;

    this.logger = logger;
    this.client_id = client_id;

    console.log( logger.get_log( 'Creating Kafka client to connect to the following brokers (producer): ' + brokers.toString() ) );

    this.client = new Kafka({
      clientId: client_id,
      brokers: brokers,
    });
  }

  /**
   * Initializes the Kafka client and creates a producer, connecting to brokers.
   */
  public async connect(): Promise<void> {
    // create a Kafka producer
    this.producer = this.client.producer({
      idempotent: true,
    });

    // connect to the producer
    try {
      await this.producer.connect();
      this.ready = true;
    } catch ( err ) {
      console.log( this.logger.get_log( 'Exception while trying to connect to Kafka brokers (producer) ' + "\n" + JSON.stringify( err ) ) );
      exit( 1 );
    }
  }

  /**
   * Publishes a feed fetch data.
   *
   * @param object msg Fetch data to publish.
   * @return void
   * @public
   */
  public async pub_feed(msg: object ): Promise<void> {
    if ( this.ready ) {
      try {
        await this.producer.send({
          topic: this.feed_fetch_channel_name,
          // TODO: replace key with open trace ID
          messages: [{ key: Date.now() + '_' + Math.random(), value: JSON.stringify( msg ) }],
          acks: -1, // must be -1 because producer is set as idempotent, i.e. each message is written exactly once
          compression: CompressionTypes.GZIP,
        });
      } catch ( err ) {
        await this.logger.log_msg( 'Error publishing feed fetch to Kafka cluster:\n' + msg.toString() + '\nerr: ' + JSON.stringify( err ), 'ERR_CONTROL_CENTER_CANNOT_PUBLISH_FEED' );
      }
    }
  }

  /**
   * Publishes new log data.
   *
   * @param object msg Log data to publish.
   * @return void
   * @public
   */
  public async log_msg( msg: object ): Promise<void> {
    if ( this.ready ) {
      try {
        await this.producer.send({
          topic: this.logs_channel_name,
          // TODO: replace key with open trace ID
          messages: [{ key: Date.now() + '_' + Math.random(), value: JSON.stringify( msg ) }],
          acks: -1, // must be -1 because producer is set as idempotent, i.e. each message is written exactly once
          compression: CompressionTypes.GZIP,
        });
      } catch ( err ) {
        let dt: Date = new Date();
        console.log( '[' + dt.getDate() + '.' + ( dt.getMonth() + 1 ) + '.' + dt.getFullYear() + ' ' + dt.getHours() + ':' + dt.getMinutes() + ':' + dt.getSeconds() + '] Error publishing log data to Kafka cluster:\n' + msg.toString() + "\n", err );
      }
    }
  }
}