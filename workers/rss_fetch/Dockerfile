FROM php:8.2-fpm-alpine

# Use the default dev configuration
RUN mv "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini"

# install composer
RUN php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
RUN php composer-setup.php --install-dir=/usr/local/bin --filename=composer
RUN php -r "unlink('composer-setup.php');"

# install pecl dependencies
RUN apk update
RUN apk add --no-cache --virtual .phpize-deps-configure $PHPIZE_DEPS

# install PhpRedis
RUN pecl install redis

# add redis extension to php.ini
RUN echo "extension=redis" | tee -a $PHP_INI_DIR/php.ini > /dev/null

COPY app /usr/src/rss_fetch
WORKDIR /usr/src/rss_fetch
COPY env.sh /env.sh

# install packages
ENV COMPOSER_ALLOW_SUPERUSER 1
RUN composer require jdecool/jsonfeed

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && php ./rss-fetch.php" ]
CMD [ "/bin/sh", "-c", "source /env.sh && php ./rss-fetch.php" ]