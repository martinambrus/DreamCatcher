import { env, exit } from "node:process";
import * as http from 'node:http';
import * as https from 'node:https';
import CacheableLookup from 'cacheable-lookup';
import { Utils } from './Utils/Utils.js';
import { XML_Parser } from './XML_Parser.js';
import { JSON_Parser } from './JSON_Parser.js';
import fetch from 'node-fetch';
import { Telemetry } from './Telemetry.js';
import { IKeyStorePub } from './Utils/MQ/KeyStore/Interfaces/IKeyStorePub.js';
import { ILogger, LOG_SEVERITIES } from './Utils/MQ/KeyStore/Interfaces/ILogger.js';
import { IMessageQueuePub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueuePub.js';
import { IMessageQueueSub } from './Utils/MQ/KeyStore/Interfaces/IMessageQueueSub.js';
import * as dfel from 'detect-file-encoding-and-language';
const languageEncoding = dfel.default;
const cacheable: CacheableLookup = new CacheableLookup();

export class RSSFetch {

  /**
   * Current version of this service.
   * Must be changed for each production-ready release.
   * @private
   * @type { string }
   */
  private readonly version: string = '0.1a';

  /**
   * Instance of the Logger class.
   * @private
   * @type { ILogger }
   */
  private readonly logger: ILogger;

  /**
   * Instance of the MQ Producer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { IMessageQueuePub }
   */
  private readonly mq_producer: IMessageQueuePub;

  /**
   * Instance of the MQ Consumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { IMessageQueueSub }
   */
  private readonly mq_consumer: IMessageQueueSub;

  /**
   * Key store publisher and getter client instance,
   * used to fetch error codes.
   * @type { IKeyStorePub }
   * @private
   */
  private readonly key_store_pub: IKeyStorePub;

  /**
   * Parser for RSS/ATOM feed data.
   * @private
   * @type { XML_Parser }
   */
  private readonly xml_parser: XML_Parser;

  /**
   * Parsef for JSON feed data.
   * @private
   * @type { JSON_Parser }
   */
  private readonly json_parser: JSON_Parser;

  /**
   * Name of the service, used in key store heartbeat updates.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Local HTTP agent to be used in node-fetch module.
   * @private
   * @type { http.Agent }
   */
  private readonly http_agent: http.Agent;

  /**
   * Local HTTPS agent to be used in node-fetch module.
   * @private
   * @type { https.Agent }
   */
  private readonly https_agent: https.Agent;

  /**
   * Stores references to key store, PGSQL and Logger classes
   * that were created outside of this main class.
   * Also creates instances of XML and JSON parser internal classes.
   *
   * @param { IMessageQueuePub } mq_producer   MQ Producer used to publish messages.
   * @param { IMessageQueueSub } mq_consumer   MQ Consumer used to listen for RSS feeds to parse.
   * @param { ILogger }          logger        A Logger class instanced used for logging purposes.
   * @param { string }           service_name  ID of the service from main application for key store publishing purposes
   * @param { IKeyStorePub }     key_store_pub A Key Store Pub client to fetch error codes.
   */
  constructor( mq_producer: IMessageQueuePub, mq_consumer: IMessageQueueSub, logger: ILogger, service_name: string, key_store_pub: IKeyStorePub ) {
    // Utilities class init
    Utils.service_name = service_name;
    Utils.logger = logger;
    Utils.mq_producer = mq_producer;

    // initialize http+s agents
    this.http_agent = new http.Agent({
      keepAlive: true,
    });

    this.https_agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: false,
    });

    // install DNS cache for all HTTP and HTTPS requests globally
    cacheable.install( this.http_agent );
    cacheable.install( this.https_agent );

    // MQ
    this.mq_producer = mq_producer;
    this.mq_consumer = mq_consumer;

    // Logger
    this.logger = logger;

    // key store
    this.key_store_pub = key_store_pub;

    // XML parser
    this.xml_parser = new XML_Parser();

    // JSON parser
    this.json_parser = new JSON_Parser();

    // strings
    this.service_name = service_name;

    // publish info about our instance going live
    this.logger.log_msg( 'rss_fetch up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );

    let self = this;

    // create a task that will update this service active status every minute
    // ... this is here in case Redis goes down, so we can show that we are alive again
    setInterval( (): void => {
      self.key_store_pub.set( self.service_name + '_active', 1 );
    }, 60000 );

    // subscribe to receive RSS feed links to be parsed
    this.mq_consumer.consume( env.FEED_FETCH_CHANNEL_NAME, self.parse_feed_url.bind( this ) );
  }

  /**
   * Receives RSS feed messages from MQ and starts parsing RSS feeds from them.
   *
   * @param { Object } data This is the processed data received from Kafka consumer.
   *                        Object structure: topic, message, trace_id
   * @private
   */
  private async parse_feed_url( { topic, message, trace_id } ): Promise<any> {
    let
      mq_message_data = message,
      mq_key_data: string = trace_id,
      trace_carrier: Object = JSON.parse( mq_key_data ),
      analysis_telemetry: Telemetry = await new Telemetry( this.service_name, this.version, mq_message_data.url ).start( trace_carrier ),
      telemetry_name: string = 'rss_fetch';

    if ( !mq_message_data.url ) {
      // invalid message from the control center
      await this.logger.log_msg( 'Error parsing control center RSS feed data:  ' + JSON.stringify( mq_message_data ), 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR );
    } else {
      // get data for this RSS feed URL
      try {
        const url_status_span_name: string = 'rss_fetch_url_status_plus_data';

        await analysis_telemetry.add_span( url_status_span_name, { 'feed_url' : mq_message_data.url } );
        let feed_data: { status: number, data: string, feed_url: string }|null = await this.get_url_status_with_data( mq_message_data.url, analysis_telemetry.get_telemetry_carrier() );
        analysis_telemetry.close_active_span( url_status_span_name );

        // if our feed URL changed in the process, change it here as well,
        // so we'll fire up a correct message for other services to pull links from it
        if ( feed_data.feed_url != mq_message_data.url ) {
          mq_message_data.url = feed_data.feed_url;
        }

        if ( feed_data !== null ) {
          // check that this is not a JSON feed
          let json = null;

          try {
            json = JSON.parse( feed_data.data );
          } catch ( err ) {
            // obviously not JSON, so leave json set to null and continue
          }

          if ( json === null ) {
            // this is an XML feed
            try {
              const process_xml_feed_span_name: string = 'rss_fetch_process_xml_feed';
              await analysis_telemetry.add_span( process_xml_feed_span_name, { 'feed_url' : mq_message_data.url } );
              await this.xml_parser.process_xml_feed( feed_data.data, mq_message_data.url, mq_key_data );
              analysis_telemetry.close_active_span( process_xml_feed_span_name );
            } catch( err ) {
              // something's gone wrong with XML parsing, log error
              await this.logger.log_msg( `invalid XML feed data for ${mq_message_data.url}, error was: ` + JSON.stringify( err ) + '\nfeed data: ' + feed_data.data, 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: mq_message_data.url } );
              await analysis_telemetry.add_span( telemetry_name, {}, `invalid XML feed data for ${mq_message_data.url}, error was: ` + JSON.stringify( err ) + '\nfeed data: ' + feed_data.data, 1 );
              analysis_telemetry.close_active_span( telemetry_name );
            }
          } else {
            // this is a JSON feed
            if ( json !== false ) {
              try {
                const process_json_feed_span_name: string = 'rss_fetch_process_json_feed';
                await analysis_telemetry.add_span( process_json_feed_span_name, { 'feed_url' : mq_message_data.url } );
                await this.json_parser.process_json_feed( json, mq_message_data.url, mq_key_data );
                analysis_telemetry.close_active_span( process_json_feed_span_name );
              } catch( err ) {
                // something's gone wrong with JSON parsing, log error
                await this.logger.log_msg( `invalid JSON feed data for ${mq_message_data.url}, error was: ` + JSON.stringify( err ) + '\nfeed data: ' + feed_data.data, 'ERR_RSS_FETCH_INVALID_JSON_FEED', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: mq_message_data.url } );
                await analysis_telemetry.add_span( telemetry_name, {}, `invalid JSON feed data for ${mq_message_data.url}, error was: ` + JSON.stringify( err ) + '\nfeed data: ' + feed_data.data, 1 );
                analysis_telemetry.close_active_span( telemetry_name );
              }
            } else {
              // invalid JSON feed data, log error
              await this.logger.log_msg( `invalid (unparsable) JSON feed ( ${mq_message_data.url} ) detected, body was: ${feed_data.data}`, 'ERR_RSS_FETCH_INVALID_JSON_FEED', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: mq_message_data.url } );
              await analysis_telemetry.add_span( telemetry_name, {}, `invalid (unparsable) JSON feed ( ${mq_message_data.url} ) detected, body was: ${feed_data.data}`, 1 );
              analysis_telemetry.close_active_span( telemetry_name );
            }
          }
        }
      } catch ( err ) {
        await this.logger.log_msg( 'Error processing ' + mq_message_data.url + ' with error: ' + JSON.stringify( err ), 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: mq_message_data.url } );
        await analysis_telemetry.add_span( telemetry_name, {}, 'Error processing ' + mq_message_data.url + ' with error: ' + JSON.stringify( err ), 1 );
        analysis_telemetry.close_active_span( telemetry_name );
      }

      // publish to key store that we're done with tracing
      this.key_store_pub.publish( env.TELEMETRY_CHANNEL_NAME, JSON.stringify( { service: this.service_name, trace_id: mq_key_data } ) );
    }
  }

  /**
   * Tries to get data and status code for the passed URL.
   * If the URL is invalid, this function will try to correct it
   * by trying HTTPS prefix first, then falling back to HTTP.
   *
   * @param { string } url      The URL to retrieve data for.
   * @param { string } trace_id Serialized trace carrier under which to log change in URL if it was fixed.
   * @private
   * @return { Promise<{ status: number, data: string, feed_url: string }|null> }
   * Returns either an object with status, page data received and feed URL
   * or null if the passed URL was invalid and we were unable to fix it.
   */
  private async get_url_status_with_data( url: string, trace_id: string ): Promise<{ status: number, data: string, feed_url: string }|null> {
    let
      lower_url: string = url.toLowerCase(),
      ret: { status: number, data: string, feed_url: string } = { status: -1, data: '', feed_url: '' };

    // check that the URL received is valid
    if ( !lower_url.startsWith('http://') && !lower_url.startsWith('https://') ) {
      // invalid URL, let's try to fix it
      // ... try https:// prefix first
      let
        msg: string = '',
        new_url: string = 'https://' + url;

      try {
        ret = await this.get_url_data( new_url );
        if ( ret.status >= 200 && ret.status <= 399 ) {
          msg = `changing invalid feed url ${url} to ${new_url}`;
        } else {
          throw 'fixing URL to HTTPS failed for ' + url + ' with status code: ' + ret.status;
        }
      } catch ( ex ) {
        // try http:// if secure HTTP failed
        new_url = 'http://' + url;
        try {
          ret = await this.get_url_data( new_url );
          if ( ret.status >= 200 && ret.status <= 399 ) {
            msg = `changing invalid feed url ${url} to ${new_url}`;
          } else {
            throw 'fixing URL to HTTP failed for ' + url + ' with status code: ' + ret.status;
          }
        } catch ( err ) {
          // we couldn't find the URL, log error
          await this.logger.log_msg( 'Invalid feed url, unable to parse or fix ' + url + ': ' + JSON.stringify( err ), 'ERR_RSS_FETCH_WRONG_URL_CANNOT_FIX',  LOG_SEVERITIES.LOG_SEVERITY_ERROR,{ feed_url: url } );
          ret = null;
        }
      }

      // if we got here, our URL fix was successful
      // notify the relevant service to update the URL in database
      if ( ret !== null ) {
        await this.mq_producer.send( env.RSS_INVALID_URLS_CHANEL_NAME, { feed_url: new_url, old_feed_url: url }, trace_id, url );
        await this.logger.log_msg(msg, 'ERR_RSS_FETCH_WRONG_URL', LOG_SEVERITIES.LOG_SEVERITY_NOTICE, { feed_url: new_url, old_feed_url: url, trace_id : trace_id });
      }
    } else {
      // URL is valid, retrieve data
      ret = await this.get_url_data( url );
      if ( ret.status < 200 || ret.status > 399 ) {
        throw 'Non-OK status code received: ' + ret.status + ' with body data: ' + ret.data;
      }
    }

    return ret;
  }

  /**
   * Retrieves URL data including its status code
   * and returns this for further processing.
   *
   * @param {string } url URL to get status code and data for.
   * @private
   * @return { Object } Returns an object with "status" and "data" keys.
   */
  private async get_url_data( url: string ): Promise<{ status: number, data: string, feed_url: string }> {
    try {
      let
        self = this,
        res  = await fetch( url, {
          agent:   function ( _parsedURL ) {
            if ( _parsedURL.protocol == 'http:' ) {
              return self.http_agent;
            } else {
              return self.https_agent;
            }
          },
          headers: {
            // spoof desktop browser, otherwise some services would return an error status code
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/116.0',
          },
          follow: 10,
        } );

      // check that we don't have a messed-up encoding after using UTF-8
      const buff = await res.arrayBuffer();
      let txt = ( new TextDecoder('utf-8') ).decode( buff );

      // UTF-8 didn't work for this link, let's try to guess one
      if ( txt.indexOf('��') > -1 ) {
        try {
          // @ts-ignore
          const guessed_encoding = await languageEncoding( Buffer.from( new Uint8Array( buff ) ) );
          if ( guessed_encoding && guessed_encoding.encoding ) {
            txt = ( new TextDecoder( guessed_encoding.encoding ) ).decode( buff );
          }
        } catch ( err ) {
          // if we couldn't guess an encoding of the link, just return an empty string
          self.logger.log_msg( 'Error while trying to fix encoding for RSS feed ' + url + ': ' + JSON.stringify( err ), 'ERR_RSS_FEED_FETCH_ENCODING_ERROR' );
          txt = '';
        }
      }

      return { status: res.status, data: txt, feed_url: url };
    } catch ( err ) {
      return { status: -1, data: JSON.stringify( err ), feed_url: '' };
    }
  }

}