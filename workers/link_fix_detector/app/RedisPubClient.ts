import { exit } from 'node:process';
import { createClient } from "redis";
import { Logger } from "./Logger.js";

export class RedisPubClient {

  /**
   * Redis client
   * @type { any }
   * @private
   */
  private client: any;

  /**
   * Determines whether the Redis client was successfully connected.
   * @type { boolean }
   * @private
   */
  private client_ready: boolean = false;

  /**
   * A logger class instance.
   * @type { Logger }
   * @private
   */
  private logger: Logger;

  /**
   * Stores a logger class instance.
   * @param { Logger } logger The logger class instance.
   * @constructor
   */
  constructor( logger: Logger ) {
    this.logger = logger;
  }

  /**
   * Initializes the Redis client and connects to Redis instance.
   *
   * @param { string } hostname Redis hostname.
   * @param { string } port     Redis port.
   */
  public async connect( hostname: string, port: string ): Promise<void> {
    // create a Redis client
    this.client = createClient({ url: 'redis://' + hostname + ':' + port } );

    // add error handling for cases when we can't connect to a Redis server
    this.client.on( 'error', ( err: any ): void => {
      if ( !this.client_ready ) {
        console.log( this.logger.get_log( 'Exception while trying to connect to Redis via ' + hostname + ':' + port + "\n" + JSON.stringify( err ) ) );
        exit( 1 );
      }
    });

    // on successful ready state, mark the client as ready
    this.client.on( 'ready', (): void => {
      this.client_ready = true;
      console.log( this.logger.get_log( 'Redis Pub successfully connected to Redis instance at ' + 'redis://' + hostname + ':' + port ) );
    });

    await this.client.connect();
  }

  /**
   * A proxy for Redis->get().
   *
   * @param { string } key The key for which we want to retrieve a value.
   */
  public async get( key: string ): Promise<string> {
    return await this.client.get( key );
  }

  /**
   * A proxy for Redis->set().
   *
   * @param { string } key   The key for which we want to set a value.
   * @param { string } value The value we want to set.
   */
  public async set( key: string, value: any ): Promise<string> {
    return await this.client.set( key, value );
  }

  /**
   * A proxy for Redis->publish()
   *
   * @param { string } channel Channel into which we want to publish a message.
   * @param { string } message The message we want to publish.
   */
  public async publish( channel: string, message: string ): Promise<void> {
    return await this.client.publish( channel, message );
  }
}