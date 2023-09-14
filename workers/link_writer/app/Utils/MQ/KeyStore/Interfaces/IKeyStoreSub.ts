/**
 * Interface for key store subscribing client.
 */
export interface IKeyStoreSub {

  /**
   * Initializes the key store client and connects to key store backend instance.
   *
   * @param { string } url  Either a single key store server hostname (if the second port parameter is set)
   *                        or a string containing URLs for a key store server cluster.
   * @param { string } port Key store port.
   */
  connect( url: string, port: string ): Promise<void>;

  /**
   * Returns the connection from key store class.
   */
  get_connection(): any;

  /**
   * A proxy for KeyStoreClass->subscribe()
   *
   * @param { string|Array<string> } channel  Name of the channel(s) to subscribe to.
   * @param { Function }             callback Function to be executed when a new message from our channel arrives.
   */
  subscribe( channel: string|Array<string>, callback: any );

}