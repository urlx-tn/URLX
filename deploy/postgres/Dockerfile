FROM postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5

# Keep PostgreSQL 18 and the official image contract, but take the fixed
# runtime libraries from Alpine's maintained v3.24 repository.
RUN set -eu; \
	apk upgrade --no-cache brotli-libs libcurl; \
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
	assert_apk_floor libcurl 8.23.0-r0
