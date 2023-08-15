import { exit } from 'node:process';
import { Kafka, Consumer, EachMessageHandler } from 'kafkajs';
import { Logger } from "./Logger.js";

export class KafkaConsumer {

  /**
   * Kafka client
   * @type { Kafka }
   * @private
   */
  private client: Kafka;

  /**
   * Identification for this Kafka consumer.
   * @type { string }
   * @private
   */
  private client_id: string;

  /**
   * Kafka consumer
   * @type { any }
   * @private
   */
  private consumer: Consumer;

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
   * @param { string }        client_id ID of the client that uniquely identifies this Kafka consumer.
   *
   * @constructor
   */
  constructor( brokers: Array<string>, logger: Logger, client_id: string ) {
    // check for a valid brokers array
    if ( brokers.length == 1 && brokers[ 0 ] == '' ) {
      // we're most probably missing an ENV key
      console.log( logger.get_log( 'Brokers missing for Kafka Consumer! Received: ' + brokers.toString() ) );
      exit( 1 );
    }

    this.logger = logger;
    this.client_id = client_id;

    console.log( logger.get_log( 'Creating Kafka client to connect to the following brokers (consumer): ' + brokers.toString() ) );

    this.client = new Kafka({
      clientId: client_id,
      brokers: brokers,
    });
  }

  /**
   * Initializes the Kafka client and creates a consumer, connecting to brokers.
   */
  public async connect(): Promise<void> {
    // create a Kafka consumer
    this.consumer = this.client.consumer({
      groupId: this.client_id,
    });

    // connect to the consumer
    try {
      await this.consumer.connect();
      this.ready = true;
      console.log( this.logger.get_log( 'Successfully connected to Kafka brokers (consumer).' ) );
    } catch ( err ) {
      console.log( this.logger.get_log( 'Exception while trying to connect to Kafka brokers (consumer) ' + "\n" + JSON.stringify( err ) ) );
      exit( 1 );
    }
  }

  /**
   * Subscribes to the given Kafka topics.
   * @param { Array<string> } topics List of topics to subscribe to.
   */
  public async subscribe( topics: Array<string> ): Promise<void> {
    await this.consumer.subscribe( { topics: topics } );
    this.logger.get_log( 'subscribed to the following topics: ' + topics.toString() );
  }

  /**
   * Consumes messages from the given channel and passes them
   * to the callback function provided.
   *
   * @param { Function } callback The callback function to call when a new message arrives.
   * @return void
   * @public
   */
  public async consume( callback: EachMessageHandler ): Promise<boolean> {
    let ret: boolean = true;

    if ( this.ready ) {
      try {
        await this.consumer.run({ eachMessage: callback });
        this.logger.get_log( 'now consuming RSS feed messages' );
      } catch ( err ) {
        // no await - we're returning boolean that's manually set below
        this.logger.log_msg( 'Error setting consumer callback: ' + JSON.stringify( err ), 'ERR_RSS_FETCH_PROCESSING' );
        ret = false;
      }
    } else {
      ret = false;
    }

    return ret;
  }

  /**
   * Determines whether this consumer is ready to consume messages.
   * @return { boolean } Returns TRUE if this consumer is connected and ready, FALSE otherwise.
   */
  public get_active(): boolean {
    return this.ready;
  }
}