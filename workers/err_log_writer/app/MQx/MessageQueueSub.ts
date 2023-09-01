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
   * Determines whether the Kafka client was successfully connected.
   * @type { boolean }
   * @private
   */
  private ready: boolean = false;

  /**
   * Determines whether the Kafka consumer is already running
   * with a consume function present.
   * @type { boolean }
   * @private
   */
  private running: boolean = false;

  /**
   * While the consumer is not connected / ready, we'll store all consume requests
   * into this array and we'll retry them as soon as we connect.
   * @private
   */
  private retry_queue: Array<{ topic: string|Array<string>, callback: Function }> = [];

  /**
   * Passes the connection and logger instances to this class.
   *
   * @param { string }  client_id  ID of the client to be used in the Consumer.
   * @param { any }     connection Connection to the backend MQ server.
   * @param { ILogger } logger     Instance of the logger class.
   *
   * @constructor
   */
  constructor( client_id: string, connection: any, logger: ILogger ) {
    this.client_id = client_id;
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

      // check and process retry queue
      if ( this.retry_queue.length ) {
        for ( let item of this.retry_queue ) {
          this.consume( item.topic, item.callback );
        }

        // reset the retry queue
        this.retry_queue = [];
      }
    }).catch( (err) => {
      console.log( this.logger.format( 'Exception while trying to connect to Kafka brokers (consumer) ' + "\n" + err.message ) );
      exit( 1 );
    });
  }

  /**
   * Consumes messages from the given topic and passes them
   * to the callback function provided.
   *
   * @param { string|Array<string> } topic    The topic(s) from which we want to be receiving messages with this class instance.
   * @param { Function }             callback The callback function to call when a new message arrives.
   *
   * @return Promise<void>
   * @public
   */
  public async consume( topic: string|Array<string>, callback: Function ): Promise<void> {
    if ( this.ready ) {
      if ( this.running ) {
        throw 'This consumer is already processing messages via a previously passed method. Please create a new consumer with its unique ID to subscribe with a new method or create a single method that would handle subscription to multiple topics.';
      } else {
        if ( !( topic instanceof Array ) ) {
          topic = [ topic ];
        }

        // create the topic with a relevant replication factor
        await this.client.admin().createTopics({
          topics: topic.map( ( topic ) => ({
            topic,
            numPartitions: 1,
            replicationFactor: 3,
            configEntries: [{ name: "min.insync.replicas", value: "2" }],
          })),
        });

        await this.consumer.subscribe( { topics: topic } );
        this.logger.format( 'subscribed to the following topic: ' + topic );
      }

      try {
        await this.consumer.run( { eachMessage: async ( { topic, partition, message, heartbeat, pause } ): Promise<void> => {
            const
              original_msg: string = message.value.toString(),
              trace_id_string: string = message.key.toString();

            message = JSON.parse( original_msg );

            if ( message ) {
              callback( { topic: topic, message: message, trace_id: trace_id_string } );
            } else {
              console.log( this.logger.format('Exception while trying to decode log data: ' + original_msg ) );
            }
        }});
        this.running = true;
        this.logger.format( 'now consuming messages from topic ' + topic );
      } catch ( err ) {
        // no await - we're returning boolean that's manually set below
        this.logger.log_msg( 'Error setting consumer callback: ' + JSON.stringify( err ), 'ERR_RSS_FETCH_PROCESSING' );
      }
    } else {
      this.retry_queue.push( { topic: topic, callback: callback } );
    }
  }

}