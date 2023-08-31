import { exit } from 'node:process';
import { ILogger } from "./Interfaces/ILogger.js";
import { Redis } from 'ioredis';

/**
 * Base class for both, Pub and Sub key store class variants.
 */
export class KeyStoreClientBase {

  /**
   * Identifies the actual Key Store client in use. Used for logging purposes.
   * @private
   */
  private client_name: string = 'Redis';

  /**
   * Client
   * @type { Redis }
   * @protected
   */
  protected client: Redis;

  /**
   * Determines whether the client was successfully connected.
   * @type { boolean }
   * @protected
   */
  protected client_ready: boolean = false;

  /**
   * A logger class instance.
   * @type { ILogger }
   * @protected
   */
  protected logger: ILogger;

  /**
   * Client identification (pub / sub).
   * Used for logging purposes.
   *
   * @type { string }
   * @protected
   */
  protected name: string;

  /**
   * Stores a logger class instance.
   *
   * @param { string }  name   Name of this instance ( pub / sub ) for logging purposes.
   * @param { ILogger } logger The logger class instance.
   * @constructor
   */
  constructor( name: string, logger: ILogger ) {
    this.name = name;
    this.logger = logger;
  }

  /**
   * Initializes the client and connects to its backend.
   *
   * @param { string } url  Either a single key store server hostname (if the second port parameter is set)
   *                        or a string containing URLs for a key store cluster.
   * @param { string } port Key store port.
   */
  public async connect( url: string, port: string = null ): Promise<void> {
    if ( port ) {
      // create a single server client
      // @ts-ignore
      this.client = new Redis({
        port: port,
        host: url,
      });
    } else{
      // create a cluster
      let
        cluster: Array<string> = url.split(','),
        connection_object: { name: string, sentinels: Array<{ host: string, port: string }> } = { name: 'main', sentinels: [] };
      for ( let node_string of cluster ) {
        let node_string_parsed = node_string.split(':');
        connection_object.sentinels.push( { host: node_string_parsed[ 0 ], port: node_string_parsed[ 1 ] } );
      }

      // @ts-ignore
      this.client = new Redis( connection_object );
    }

    // add error handling for cases when we can't connect to a server
    this.client.on( 'error', ( err: any ): void => {
      if ( !this.client_ready ) {
        console.log( this.logger.format( 'Exception while trying to connect to ' + this.client_name + ' (' + this.name + ') via ' + url + ':' + port + "\n" + JSON.stringify( err ) ) );
        exit( 1 );
      }
    });

    // on successful ready state, mark the client as ready
    this.client.on( 'ready', (): void => {
      this.client_ready = true;
      console.log( this.logger.format( 'Successfully connected to ' + this.client_name + ' (' + this.name + ') via ' + url + ( port ? ':' + port : '' ) ) );
    });
  }
}