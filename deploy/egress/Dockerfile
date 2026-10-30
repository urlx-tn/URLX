FROM ubuntu:24.04
# Refresh the Noble base and keep Squid at or above Canonical's security floor.
RUN set -eu; \
	apt-get update; \
	DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends; \
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends squid; \
	squid_version="$(dpkg-query -W -f='${Version}' squid)"; \
	dpkg --compare-versions "$squid_version" ge 6.14-0ubuntu0.24.04.5; \
	test "$(id -u proxy)" = 13; \
	test "$(id -g proxy)" = 13; \
	rm -rf /var/lib/apt/lists/*
COPY squid.conf /etc/squid/squid.conf
COPY entrypoint.sh /usr/local/bin/urlx-squid-entrypoint
RUN chmod 0555 /usr/local/bin/urlx-squid-entrypoint
ENTRYPOINT ["/usr/local/bin/urlx-squid-entrypoint"]
USER proxy:proxy
