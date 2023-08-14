import { LOG_SEVERITIES, Logger } from "./Logger.js";
import { KafkaProducer } from "./KafkaProducer.js";
import { KafkaConsumer } from "./KafkaConsumer.js";
import { env, exit } from "node:process";
import * as http from 'node:http';
import * as https from 'node:https';
import CacheableLookup from 'cacheable-lookup';
import { Utils } from './Utils.js';
import { XML_Parser } from './XML_Parser.js';
import { JSON_Parser } from './JSON_Parser.js';
import fetch from 'node-fetch';
const cacheable: CacheableLookup = new CacheableLookup();

export class RSSFetch {

  /**
   * Instance of the Logger class.
   * @private
   * @type { Logger }
   */
  private readonly logger: Logger;

  /**
   * Instance of the KafkaProducer used for message publishing
   * sections of the code.
   * @private
   * @type { KafkaProducer }
   */
  private readonly kafka_producer: KafkaProducer;

  /**
   * Instance of the KafkaConsumer used to listen
   * for RSS feeds to parse.
   * @private
   * @type { KafkaConsumer }
   */
  private readonly kafka_consumer: KafkaConsumer;

  /**
   * Redis client instance, used to fetch error codes.
   * @type { any }
   * @private
   */
  private readonly redis_client: any;

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
   * Name of the service, used in Redis heartbeat updates.
   * @private
   * @type { string }
   */
  private readonly service_name: string;

  /**
   * Feeds fetch channel name.
   * @private
   * @type { string }
   */
  private feed_fetch_channel_name: string;

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
   * Stores references to Kafka, PGSQL and Logger classes
   * that were created outside of this main class.
   * Also creates instances of XML and JSON parser internal classes.
   *
   * @param { KafkaProducer } kafka_producer Kafka Producer used to publish messages.
   * @param { KafkaConsumer } kafka_consumer Kafka Consumer used to listen for RSS feeds to parse.
   * @param { Logger }        logger         A Logger class instanced used for logging purposes.
   * @param { any }           redisClient    A Redis client to fetch error codes.
   */
  constructor( kafka_producer: KafkaProducer, kafka_consumer: KafkaConsumer, logger: Logger, redisClient: any, service_name: string ) {
    // initialize Utils static class with default values
    Utils.kafka_producer = kafka_producer;
    Utils.service_name = service_name;

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

    // Kafka
    this.kafka_producer = kafka_producer;
    this.kafka_consumer = kafka_consumer;

    // Logger
    this.logger = logger;

    // Redis
    this.redis_client = redisClient;

    // XML parser
    this.xml_parser = new XML_Parser();

    // JSON parser
    this.json_parser = new JSON_Parser();

    // strings
    this.service_name = service_name;
    this.feed_fetch_channel_name = env.KAFKA_FEED_FETCH_CHANNEL;

    let self = this;

    // create a task that will update this service active status every minute
    setInterval( (): void => {
      if ( self.kafka_consumer.get_active() && self.kafka_producer.get_active() ) {
        self.redis_client.set( self.service_name + '_active', 1 );
      }
    }, 60000 );

    // mark ourselves as active from the start, if both - producer and consumer - are active
    if ( this.kafka_consumer.get_active() && this.kafka_producer.get_active() ) {
      this.redis_client.set( this.service_name + '_active', 1 );
    }

    // subscribe to receive RSS feed links to be parsed
    this.kafka_consumer.subscribe( [ this.feed_fetch_channel_name ] ).then( async () => {
      // start processing RSS feed URLs
      if ( !await self.kafka_consumer.consume( self.parse_feed_url.bind( this ) ) ) {
        let exit_code: number = parseInt( await self.redis_client.get( 'ERR_RSS_FETCH_KAFKA_NOT_READY' ) );
        await self.logger.log_msg( 'Error while trying to set RSS parsing function - Kafka Consumer not ready.', exit_code );
        exit( exit_code );
      }

      // publish info about our instance going live
      await this.logger.log_msg( this.service_name + ' up and running', 0, LOG_SEVERITIES.LOG_SEVERITY_LOG );
    });
  }

  /**
   * Receives Kafka RSS feed messages and starts parsing RSS feeds from them.
   *
   * @param { Object } data This is the data received from Kafka consumer.
   *                        Object structure: topic, partition, message, heartbeat, pause
   * @private
   */
  private async parse_feed_url( { topic, partition, message, heartbeat, pause } ): Promise<void> {
    if ( topic == this.feed_fetch_channel_name ) {
      let kafka_message_data = null;
      try {
        kafka_message_data = JSON.parse(message.value.toString());
      } catch ( err ) {
        await this.logger.log_msg( 'Error parsing control center RSS feed data:  ' + message + '\nerr: ' + JSON.stringify( err ), 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: kafka_message_data.url } );
      }

      if ( !kafka_message_data || !kafka_message_data.url ) {
        // invalid message from the control center
        await this.logger.log_msg( 'Error parsing control center RSS feed data:  ' + message, 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: kafka_message_data.url } );
      } else {
        // get data for this RSS feed URL
        try {
          let feed_data: { status: number, data: string }|null = await this.get_url_status_with_data( kafka_message_data.url );
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
                await this.xml_parser.process_xml_feed( feed_data.data, kafka_message_data.url );
              } catch( err ) {
                // something's gone wrong with XML parsing, log error
                await this.logger.log_msg( `invalid XML feed data for ${kafka_message_data.url}, error was: ` + JSON.stringify( err ) + '\nfeed data: ' + feed_data.data, 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: kafka_message_data.url } );
              }
            } else {
              // this is a JSON feed
              if ( json !== false ) {
                try {
                  await this.json_parser.process_json_feed( json, kafka_message_data.url );
                } catch( err ) {
                  // something's gone wrong with JSON parsing, log error
                  await this.logger.log_msg( `invalid JSON feed data for ${kafka_message_data.url}, error was: ` + JSON.stringify( err ) + '\nfeed data: ' + feed_data.data, 'ERR_RSS_FETCH_INVALID_JSON_FEED', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: kafka_message_data.url } );
                }
              } else {
                // invalid JSON feed data, log error
                await this.logger.log_msg( `invalid (unparsable) JSON feed ( ${kafka_message_data.url} ) detected, body was: ${feed_data.data}`, 'ERR_RSS_FETCH_INVALID_JSON_FEED', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: kafka_message_data.url } );
              }
            }
          }
        } catch ( err ) {
          await this.logger.log_msg( 'Error processing ' + kafka_message_data.url + ' with error: ' + JSON.stringify( err ), 'ERR_RSS_FETCH_PROCESSING', LOG_SEVERITIES.LOG_SEVERITY_ERROR, { feed_url: kafka_message_data.url } );
        }
      }
    }
  }

  /**
   * Tries to get data and status code for the passed URL.
   * If the URL is invalid, this function will try to correct it
   * by trying HTTPS prefix first, then falling back to HTTP.
   *
   * @param { string } url The URL to retrieve data for.
   * @private
   * @return { Promise<{ status: number, data: string }|null> } Returns either an object with status and page data received
   *                                                            or null if the passed URL was invalid and we were unable to fix it.
   */
  private async get_url_status_with_data( url: string ): Promise<{ status: number, data: string }|null> {
    let
      lower_url: string = url.toLowerCase(),
      ret: { status: number, data: string } = { status: -1, data: '' };

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
        await this.logger.log_msg(msg, 'ERR_RSS_FETCH_WRONG_URL', LOG_SEVERITIES.LOG_SEVERITY_NOTICE, {feed_url: new_url, old_feed_url: url});
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
  private async get_url_data( url: string ): Promise<{ status: number, data: string }> {
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

      return { status: res.status, data: await res.text() };
    } catch ( err ) {
      return { status: -1, data: JSON.stringify( err ) };
    }
  }

}