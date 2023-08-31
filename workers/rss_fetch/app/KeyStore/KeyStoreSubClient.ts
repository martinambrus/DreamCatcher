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
   * @param { string }   channel  Name of the channel to subscribe to.
   * @param { Function } callback Function to be executed when a new message from our channel arrives.
   */
  public subscribe( channel: string, callback: any ) {
    this.client.subscribe( channel, callback );
  }

}