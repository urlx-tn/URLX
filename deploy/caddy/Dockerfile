FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f

# Keep the official Caddy image contract and Alpine v3.23 while taking the
# fixed runtime libraries from Alpine's maintained v3.23 repository.
RUN set -eu; \
	apk upgrade --no-cache brotli-libs curl libcurl; \
	assert_apk_floor() { \
		package="$1"; \
		minimum="$2"; \
		package_version="$(apk info -a "$package" | sed -n '1s/[[:space:]].*$//p')"; \
		case "$package_version" in \
			"$package"-*) installed="${package_version#"$package"-}" ;; \
			*) echo "Could not read installed version for $package" >&2; exit 1 ;; \
		esac; \
		comparison="$(apk version -t "$installed" "$minimum")"; \
		case "$comparison" in \
			'='|'>' ) ;; \
			*) echo "$package $installed is below required $minimum" >&2; exit 1 ;; \
		esac; \
	}; \
	assert_apk_floor brotli-libs 1.2.1-r0; \
	assert_apk_floor curl 8.23.0-r0; \
	assert_apk_floor libcurl 8.23.0-r0
