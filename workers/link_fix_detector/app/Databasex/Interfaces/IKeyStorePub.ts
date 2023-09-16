/**
 * Interface for key store publishing client.
 */
export interface IKeyStorePub {

  /**
   * Initializes the key store client and connects to the key store backend instance.
   *
   * @param { string } url  Either a single key store backend hostname (if the second port parameter is set)
   *                        or a string containing URLs for a key store backend cluster.
   * @param { string } port Key store port.
   */
  connect( url: string, port: string ): Promise<void>;

  /**
   * Returns the connection from key store class.
   */
  get_connection(): any;

  /**
   * A proxy for KeyStoreClass->get().
   *
   * @param { string } key The key for which we want to retrieve a value.
   */
  get( key: string ): Promise<string>;

  /**
   * A proxy for KeyStoreClass->set().
   *
   * @param { string } key   The key for which we want to set a value.
   * @param { string } value The value we want to set.
   */
  set( key: string, value: any ): Promise<string>;

  /**
   * A proxy for KeyStore->del().
   *
   * @param { string } key The key we want to remove.
   */
  delete( key: string ): Promise<number>;

  /**
   * A proxy for KeyStoreClass->sadd().
   *
   * @param { string } set_name The set name where we want to add data to.
   * @param { string } value    The value we want to add to a set.
   */
  sadd( set_name: string, value: any ): Promise<number>;

  /**
   * A proxy for KeyStore->srem().
   *
   * @param { string } set_name The set name from where we want to remove data.
   * @param { string } value    The value we want to remove from the set.
   */
  sdelete( set_name: string, value: any ): Promise<number>;

  /**
   * A proxy for KeyStore->smembers().
   *
   * @param { string } set_name The set name for which we want to retrieve members.
   */
  smembers( set_name: string ): Promise<string[]>;

  /**
   * A proxy for KeyStoreClass->publish()
   *
   * @param { string } channel Channel into which we want to publish a message.
   * @param { string } message The message we want to publish.
   */
  publish( channel: string, message: string ): Promise<number>;

}