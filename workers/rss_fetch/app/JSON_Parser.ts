import { DateTime } from "luxon";
import { Utils } from './Utils.js';

export class JSON_Parser {

  /**
   * Processes JSON feed data and publishes each item
   * as a individual Kafka message for further processing.
   *
   * @param { Object } json_data JSON feed object with all its data.
   * @param { string } feed_url  URL of the feed from which the json_data object was created.
   * @private
   */
  public async process_json_feed( json_data: Object, feed_url: string ): Promise<void> {
    // check for the JSON data validity - we only require items here,
    // no need to check for other relevant keys as per the JSON RSS Feed 1.1 specs
    // https://www.jsonfeed.org/version/1.1/
    if ( json_data[ 'items' ] && json_data[ 'items' ] instanceof Array ) {
      // we will sort final Kafka item messages by date, so they are ordered from oldest to newest
      let
        items_to_sort: Array<Object> = [],
        url_counter = 1;

      for ( let item of json_data[ 'items' ] ) {
        let
          url: string = '',
          summary: string = '',
          link_img: string = '',
          categories: Array<string> = [],
          authors: Array<string> = [],
          date_published: number = Math.round( Date.now() / 1000 );

        // get item's URL
        url = this.json_item_get_url( item );

        // continue only if there is enough data to store
        if ( url !== '' || item[ 'content_html' ] || item[ 'content_text' ] || item[ 'summary' ] || item[ 'title' ] || item[ '_content_html' ] || item[ '_content_text' ] || item[ '_summary' ] || item[ '_title' ] ) {
          // try to extract link image
          link_img = this.json_item_get_main_image( item );

          // assemble tags (called categories here to keep the variable name consistent with DB structure)
          if ( ( item[ 'tags' ] && item[ 'tags' ] instanceof Array ) || ( item[ '_tags' ] && item[ '_tags' ] instanceof Array ) ) {
            categories = ( item[ 'tags' ] ?? item[ '_tags' ] );
          }

          // try to get authors
          authors = this.json_item_get_authors( item, json_data );

          // update the published date, if one is found
          if ( item[ 'date_published' ] || item[ '_date_published' ] ) {
            date_published = DateTime.fromISO( ( item[ 'date_published' ] ?? item[ '_date_published' ] ) ).toUnixInteger();
          } else if ( item[ 'date_modified' ] || item[ '_date_modified' ] ) {
            date_published = DateTime.fromISO( ( item[ 'date_modified' ] ?? item[ '_date_modified' ] ) ).toUnixInteger();
          }

          if ( item[ 'summary' ] || item[ '_summary' ] ) {
            summary = Utils.untagize(item[ 'summary' ] ?? item[ '_summary' ] );
          } else if ( item[ 'content_text' ] || item[ '_content_text' ] || item[ 'content_html' ] || item[ '_content_html' ] ) {
            // try to extract summary from the content_text or content_html key
            if ( item[ 'content_text' ] || item[ '_content_text' ] ) {
              summary = Utils.generate_summary( item[ 'content_text' ] ?? item[ '_content_text' ] );
            } else if ( item[ 'content_html' ] || item[ '_content_html' ] ) {
              summary = Utils.generate_summary( item[ 'content_html' ] ?? item[ '_content_html' ] );
            }
          }

          // no url - make it a hash with published date
          if ( !url || typeof( url ) == 'undefined' ) {
            url = '#' + feed_url.replace( 'http://', '' ).replace( 'https://', '' ) + date_published + url_counter++;
          }

          let feed_item_info: Object = {
            'title':     Utils.untagize( item['title'] ?? item['_title'] ),
            'summary':   summary,
            'link':      url,
            'img':       link_img,
            'published': date_published,
            'feed_url':  feed_url,
          };

          if ( categories.length ) {
            feed_item_info[ 'categories' ] = categories;
          }

          if ( authors.length ) {
            feed_item_info[ 'authors' ] = authors;
          }

          items_to_sort.push( feed_item_info );
        }
      }

      // sort items by date, ascending (oldest to newest)
      items_to_sort.sort( (a: Object, b: Object): number => {
        return a[ 'published' ] - b[ 'published' ];
      });

      // fire up links data
      for ( let link_data of items_to_sort ) {
        // no await - we're not checking whether this link was successfully added
        Utils.publish_new_link_data( link_data );
      }
    } else {
      // invalid JSON feed data
      throw 'JSON feed missing items section';
    }
  }

  /**
   * Determines main image URL from a JSON feed item.
   *
   * @param { Object } item      JSON feed item to get main image URL from.
   * @param { Object } json_feed The actual full JSON feed, since authors may be stored there
   *                             instead of on a per-item basis.
   * @private
   * @return { Array<string> } Returns array of authors.
   */
  private json_item_get_authors( item: Object, json_feed: Object ): Array<string> {
    let
      authors: Array<string> = [],
      authors_object: Object = null;

    // try to detect where the authors object resides - whether in our item or the root of JSON feed object (or nowhere)
    if ( ( item[ 'authors' ] && item[ 'authors' ] instanceof Object ) || ( item[ '_authors' ] && item[ '_authors' ] instanceof Object ) ) {
      authors_object = ( item[ 'authors' ] ?? item[ '_authors' ] );
    } else if ( ( json_feed[ 'authors' ] && json_feed[ 'authors' ] instanceof Object ) || ( json_feed[ '_authors' ] && json_feed[ '_authors' ] instanceof Object ) ) {
      authors_object = ( json_feed[ 'authors' ] ?? json_feed[ '_authors' ] );
    }

    // if we've detected authors anywhere, assemble them here
    if ( authors_object !== null ) {
      if ( authors_object[ 'name' ] ) {
        authors.push( authors_object[ 'name' ] );
      } else if ( authors_object[ 'url' ] && !authors_object[ 'url' ].toLowerCase().startsWith( 'http' ) ) {
        // some XML-based feeds were found to have author name stored in author's URL,
        // so let's preemptively check for this instance of trickery here as well
        authors.push( authors_object[ 'url' ] );
      }
    }

    return authors;
  }

  /**
   * Determines main image URL from a JSON feed item.
   *
   * @param { Object } item JSON feed item to get main image URL from.
   * @private
   * @return { string } Returns URL for the main image of the given item or empty string if no image was found.
   */
  private json_item_get_main_image( item: Object ): string {
    let img: string = '';

    if ( item[ 'banner_image' ] || item[ '_banner_image' ] ) {
      img = ( item[ 'banner_image' ] ?? item[ '_banner_image' ] );
    } else if ( item[ 'image' ] || item[ '_image' ] ) {
      img = ( item[ 'image' ] ?? item[ '_image' ] );
    } else {
      // check if we can find image in the summary or content
      // ... even though content_text and summary are plain text fields,
      //     we can't be sure someone wouldn't abuse the standard and put HTML there,
      //     so we check those as well if no image is found in content_html
      if ( item[ 'content_html' ] || item[ '_content_html' ] ) {
        img = Utils.get_first_img_from_html( ( item[ 'content_html' ] ?? item[ '_content_html' ] ) );
      }

      if ( item[ 'content_text' ] || item[ '_content_text' ] ) {
        img = Utils.get_first_img_from_html( ( item[ 'content_text' ] ?? item[ '_content_text' ] ) );
      } else if ( item[ 'summary' ] || item[ '_summary' ] ) {
        img = Utils.get_first_img_from_html( ( item[ 'summary' ] ?? item[ '_summary' ] ) );
      }
    }

    return img;
  }

  /**
   * Determines URL from a JSON feed item.
   *
   * @param { Object } item JSON feed item to get URL from.
   * @private
   * @return { string } Returns URL for the item or empty string if no URL was found.
   */
  private json_item_get_url( item: Object ): string {
    let url: string = '';

    if ( item[ 'id' ].toLowerCase().startsWith( 'http' ) ) {
      url = item[ 'id' ];
    } else if ( item[ 'url' ] ) {
      url = item[ 'url' ];
    } else if ( item[ 'external_url' ] ) {
      url = item[ 'external_url' ];
    }

    return url;
  }

}