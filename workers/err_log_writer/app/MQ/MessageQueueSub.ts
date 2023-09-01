import { ILogger } from './KeyStore/Interfaces/ILogger.js';
import { IMessageQueueSub } from './KeyStore/Interfaces/IMessageQueueSub.js';
import { env, exit } from 'node:process';
import { Consumer, Kafka } from 'kafkajs';

/**
 * Message queue class, responsible for retrieving messages
 * across microservices and managing jobs parallelism.
 */
export class MessageQueueSub implements IMessageQueueSub {

  /**
   * Client
   * @type { Kafka }
   * @private
   */
  private client: Kafka;

  /**
   * Identification for this consumer.
   * @type { string }
   * @private
   */
  private client_id: string;

  /**
   * Consumer
   * @type { any }
   * @private
   */
  private consumer: Consumer;

  /**
   * A logger class instance.
   * @type { ILogger }
   * @private
   */
  private logger: ILogger;

  /**
   * Array of all topics to which we are currently subscribed.
   * @type { Array<string> }
   * @private
   */
  private topics_subscribed: Array<string> = [];

  /**
   * Determines whether the Kafka client was successfully connected.
   * @type { boolean }
   * @private
   */
  private ready: boolean = false;

  /**
   * Passes the connection and logger instances to this class.
   *
   * @param { any }     connection Connection to the backend MQ server.
   * @param { ILogger } logger     Instance of the logger class.
   *
   * @constructor
   */
  constructor( connection: any, logger: ILogger ) {
    this.client = connection;
    this.logger = logger;

    // create a Kafka consumer
    this.consumer = this.client.consumer({
      groupId: this.client_id,
    });

    // connect to the consumer
    this.consumer.connect().then( () => {
      this.ready = true;
      console.log( this.logger.format( 'Successfully connected to Kafka brokers (consumer).' ) );
    }).catch( (err) => {
      console.log( this.logger.format( 'Exception while trying to connect to Kafka brokers (consumer) ' + "\n" + err.message ) );
      exit( 1 );
    });
  }

  /**
   * Consumes messages from the given topic and passes them
   * to the callback function provided.
   *
   * @param { string }   topic    The topic from which we want to be receiving messages with this class instance.
   * @param { Function } callback The callback function to call when a new message arrives.
   *
   * @return Promise<void>
   * @public
   */
  public async consume( topic: string, callback: Function ): Promise<void> {
    if ( this.ready ) {
      if ( this.topics_subscribed.indexOf( topic ) > -1 ) {
        throw 'This consumer is already processing messages from the topic ' + topic + '. Please create a new consumer with its unique ID to subscribe to the same topic again.';
      } else {
        await this.consumer.subscribe( { topics: [ topic ] } );
        this.logger.format( 'subscribed to the following topic: ' + topic );
      }

      try {
        await this.consumer.run( { eachMessage: async ( { topic, partition, message, heartbeat, pause } ): Promise<void> => {
            const
              original_msg: string = message.value.toString(),
              trace_id_string: string = message.key.toString();

            message = JSON.parse( original_msg );

            if ( message ) {
              callback( topic, message, trace_id_string );
            } else {
              console.log( this.logger.format('Exception while trying to decode log data: ' + original_msg ) );
            }
        }});
        this.logger.format( 'now consuming messages from topic ' + topic );
      } catch ( err ) {
        // no await - we're returning boolean that's manually set below
        this.logger.log_msg( 'Error setting consumer callback: ' + JSON.stringify( err ), 'ERR_RSS_FETCH_PROCESSING' );
      }
    }
  }

}