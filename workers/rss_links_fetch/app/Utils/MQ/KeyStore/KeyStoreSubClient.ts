import { KeyStoreClientBase } from './KeyStoreClientBase.js';
import { ILogger } from './Interfaces/ILogger.js';
import { IKeyStoreSub } from './Interfaces/IKeyStoreSub.js';

/**
 * Subscribing variant of the key store class.
 */
export class KeyStoreSubClient extends KeyStoreClientBase implements IKeyStoreSub {

  /**
   * Stores a logger class instance.
   *
   * @param { ILogger } logger The logger class instance.
   * @constructor
   */
  constructor( logger: ILogger ) {
    super( 'Sub', logger );
  }

  /**
   * A proxy for KeyStore->subscribe()
   *
   * @param { string|Array<string> } channel  Name of the channel to subscribe to.
   * @param { Function }             callback Function to be executed when a new message from our channel arrives.
   */
  public subscribe( channel: string|Array<string>, callback: any ) {
    if ( !( channel instanceof Array ) ) {
      channel = [ channel ];
    }

    for ( let channel_name of channel ) {
      this.client.subscribe( channel_name, ( err, count ) => {
        if ( err ) {
          throw err;
        } else {
          this.client.on( 'message', ( channel, message ) => {
            if ( channel == channel_name ) {
              callback( message );
            }
          });
        }
      });
    }
  }

}