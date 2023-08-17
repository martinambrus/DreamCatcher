import { exit } from 'node:process';
import { createClient } from "redis";
import { Logger } from "./Logger.js";

export class RedisSubClient {

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
      console.log( this.logger.get_log( 'Redis Sub successfully connected to Redis instance at ' + 'redis://' + hostname + ':' + port ) );
    });

    await this.client.connect();
  }

  /**
   * A proxy for Redis->subscribe()
   *
   * @param { string }   channel  Name of the channel to subscribe to.
   * @param { Function } callback Function to be executed when a new message from our channel arrives.
   */
  public subscribe( channel: string, callback: Function ) {
    this.client.subscribe( channel, callback );
  }
}