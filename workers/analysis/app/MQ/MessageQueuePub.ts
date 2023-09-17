import { IMessageQueuePub } from './KeyStore/Interfaces/IMessageQueuePub.js';
import { env, exit } from 'node:process';
import { CompressionTypes, Kafka, Producer } from 'kafkajs';
import { ILogger, LOG_SEVERITIES } from './KeyStore/Interfaces/ILogger.js';

/**
 * Message queue class, responsible for sending messages
 * across microservices.
 */
export class MessageQueuePub implements IMessageQueuePub {

  /**
   * Client
   * @type { Kafka }
   * @private
   */
  private client: Kafka;

  /**
   * Producer
   * @type { any }
   * @private
   */
  private producer: Producer;

  /**
   * Determines whether the Kafka client was successfully connected.
   * @type { boolean }
   * @private
   */
  private ready: boolean = false;

  /**
   * A logger class instance.
   * @type { ILogger }
   * @private
   */
  private logger: ILogger;

  /**
   * While the producer is not connected / ready, we'll store messages to be sent
   * in a retry queue and we'll send them as soon as we connect.
   * @type { Array }
   * @private
   */
  private retry_queue: Array<{ topic: string, message: Object, trace_id: string }> = [];

  /**
   * An array with all topics that were already created in Kafka,
   * so we don't try to re-create them with errors.
   * Note: this will not prevent errors if a topic was created in another Kafka instance,
   *       however that error will be singular and will disappear after the topic name is cached.
   * @type { Array<string> }
   * @private
   */
  private created_topics: Array<string> = [];

  /**
   * Whether or not should this producer be sending out messages in batches.
   *
   * @type { boolean }
   * @private
   */
  private batch_mode: boolean = true;

  /**
   * How many items at maximum should be sent out in a single batch.
   *
   * @private
   */
  private batch_max_items: number = 25;

  /**
   * A queue array with messages to be sent out in a batch.
   *
   * @private
   */
  private batch_mode_queue: { [ k: string] : Array< Array< { key: string, value: string, headers? : any } > > } = {};

  /**
   * Passes the connection and logger instances to this class.
   *
   * @param { Kafka }  connection Connection to the backend MQ server.
   * @param { ILogger} logger     Instance of the logging class.
   *
   * @constructor
   */
  constructor( connection: Kafka, logger: ILogger ) {
    this.client = connection;
    this.logger = logger;

    // create a Kafka producer
    this.producer = this.client.producer({
      //idempotent: true,
    });

    // connect to the producer
    this.producer.connect().then( () => {
      this.ready = true;
      console.log( this.logger.format( 'Successfully connected to Kafka brokers (producer).' ) );

      // check and process retry queue
      if ( this.retry_queue.length ) {
        for ( let item of this.retry_queue ) {
          this.send( item.topic, item.message, item.trace_id );
        }

        // reset the retry queue
        this.retry_queue = [];
      }
    }).catch( ( err ) => {
      console.log( this.logger.format( 'Exception while trying to connect to Kafka brokers (producer) ' + "\n" + JSON.stringify( err ) ) );
      exit( 1 );
    });
  }

  /**
   * Sends a message into the given topic with the given trade ID.
   *
   * @param { string } topic         The topic to send the message to.
   * @param { Object } message       The actual message object. This will be JSON-encoded before sending.
   * @param { string } trace_id      Trace ID which we can use to continue tracing the lifetime of this request
   *                                 thorough all of the microservices ecosystem.
   */
  public async send( topic: string, message: Object, trace_id: string ): Promise<void> {
    if ( this.ready ) {
      try {
        // create the topic with a relevant replication factor
        if ( this.created_topics.indexOf( topic ) == -1 && env.MQ_NODES.indexOf(',') > -1 ) {
          await this.client.admin().createTopics({
            waitForLeaders: true,
            topics: [ topic ].map( ( topic ) => ({
              topic,
              numPartitions: 1,
              replicationFactor: 3,
              configEntries: [{ name: "min.insync.replicas", value: "2" }],
            })),
          });

          this.created_topics.push( topic );
        }

        // if we're in batch mode, let's add this message into the batch
        // and potentially send it out if we've reached max items in batch
        if ( this.batch_mode ) {
          // check where we can fit this item
          if ( !this.batch_mode_queue[ topic ] ) {
            this.batch_mode_queue[ topic ] = [];
          }

          let
            reindex: boolean = false,
            was_added: boolean = false;

          for ( let messages_index in this.batch_mode_queue[ topic ] ) {
            if ( this.batch_mode_queue[ topic ][ messages_index ].length >= this.batch_max_items ) {
              // max batch items in this queue sub-array reached,
              // let's send it out and remove it from the queue
              await this.producer.sendBatch({
                topicMessages: [
                  {
                    topic: topic,
                    messages: this.batch_mode_queue[ topic ][ messages_index ],
                  }
                ],
                //                acks: -1, // must be -1 because producer is set as idempotent, i.e. each message is written exactly once
                compression: CompressionTypes.GZIP,
              });

              delete this.batch_mode_queue[ topic ][ messages_index ];

              // reindex the array for this topic at the end, since we now have an empty set in it
              reindex = true;
            } else {
              // add this message into the messages array for this topic in the queue,
              // since there's still space
              this.batch_mode_queue[ topic ][ messages_index ].push( { key: trace_id, value: JSON.stringify( message ) } );
              was_added = true;
              break;
            }
          }

          if ( reindex ) {
            this.batch_mode_queue[ topic ] = this.batch_mode_queue[ topic ].filter(Boolean);
          }

          // check if we've added this item and if not, add it here
          // ... not adding an item can happen if we have only 1 sub-array,
          //     so the foreach loop above will only go through that
          //     and we wouldn't have any place for the new item to be added to yet
          if ( !was_added ) {
            if ( !this.batch_mode_queue[ topic ].length ) {
              this.batch_mode_queue[ topic ].push( [] );
            }

            // now add this item into the last (probably the only) array available
            this.batch_mode_queue[ topic ][ this.batch_mode_queue[ topic ].length - 1 ].push( { key: trace_id, value: JSON.stringify( message ) } );
          }
        } else {
          // not in batch mode - send message immediately
          await this.producer.send({
            topic: topic,
            messages: [{ key: trace_id, value: JSON.stringify( message ) }],
            //            acks: -1, // must be -1 because producer is set as idempotent, i.e. each message is written exactly once
            compression: CompressionTypes.GZIP,
          });
        }
      } catch ( err ) {
        try {
          await this.logger.log_msg( 'Error publishing feed fetch to Kafka cluster:\n' + JSON.stringify( message ) + '\nerr: ' + JSON.stringify( err ), 'ERR_CONTROL_CENTER_CANNOT_PUBLISH_FEED', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { trace_id: trace_id } );
        } catch ( err ) {
          // if the message object was somehow damaged and went too long to be stringified because of some sort of
          // infinite loop error just ignore it
        }
      }
    } else {
      this.retry_queue.push( { topic: topic, message: message, trace_id: trace_id } );
    }
  }

  /**
   * Returns TRUE if the publisher is in a batch mode, FALSE otherwise.
   */
  public is_batch_mode(): boolean {
    return this.batch_mode;
  }

  /**
   * Sets whether this publisher should be in batch mode or not.
   *
   * @param { boolean } to_batch_mode If true, the publisher will be set to batch mode.
   *                                  If false, the publisher will exit the batch (if it was in one)
   *                                  and will immediately send out all queued messages.
   */
  public set_batch_mode( to_batch_mode: boolean ): void {
    // check whether we're not currently in a batch mode and trying to get out of it
    // in which case we'll need to send out all the messages left in the queue.
    if ( this.batch_mode && !to_batch_mode ) {
      this.drain_batch();
      this.batch_mode_queue = {};
    }

    this.batch_mode = to_batch_mode;
  }

  /**
   * Returns the maximum number of items to be sent at once in a single batch.
   */
  public get_batch_max_items(): number {
    return this.batch_max_items;
  }

  /**
   * Sets the maximum number of items to be sent at once in a single batch.
   *
   * @param { number } max_items Maximum number of items to be sent at once in a single batch.
   */
  public set_batch_max_items( max_items: number ): void {
    this.batch_max_items = max_items;
  }

  /**
   * Sends all messages, either for the provided topic
   * or for all topics, if no topic was provided.
   *
   * @param { string } topic An optional topic for which to send all messages for.
   *                         All messages will be sent if this parameter is empty or missing.
   */
  public drain_batch( topic?: string ): void {
    for ( let batch_topic in this.batch_mode_queue ) {
      if (  !topic || typeof( topic ) == 'undefined' || batch_topic == topic ) {
        for ( let messages_index in this.batch_mode_queue[ batch_topic ] ) {
          this.producer.sendBatch({
            topicMessages: [
              {
                topic: batch_topic,
                messages: this.batch_mode_queue[ batch_topic ][ messages_index ],
              }
            ],
            //            acks: -1, // must be -1 because producer is set as idempotent, i.e. each message is written exactly once
            compression: CompressionTypes.GZIP,
          }).then( () => {
            // remove this index from the batch
            delete this.batch_mode_queue[ batch_topic ][ messages_index ];

            // reindex the array
            this.batch_mode_queue[ batch_topic ] = this.batch_mode_queue[ batch_topic ].filter(Boolean);
          });
        }
      }
    }
  }

}