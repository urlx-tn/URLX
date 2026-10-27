INSERT INTO public.form_limits (
	id,
	max_published,
	max_monthly_responses,
	max_retained_responses
)
VALUES (1, 25, 1000, 10000)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION public.lock_form_owner(p_owner_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
	INSERT INTO public.form_owner_locks (owner_id)
	VALUES (p_owner_id)
	ON CONFLICT (owner_id) DO NOTHING;
	PERFORM 1
	FROM public.form_owner_locks AS guard
	WHERE guard.owner_id = p_owner_id
	FOR UPDATE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.lock_form_alias(p_alias text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
	INSERT INTO public.form_alias_locks (alias)
	VALUES (p_alias)
	ON CONFLICT (alias) DO NOTHING;
	PERFORM 1
	FROM public.form_alias_locks AS guard
	WHERE guard.alias = p_alias
	FOR UPDATE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.guard_form_response_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	owner_key text;
	response_month text;
	usage_count integer;
	monthly_limit integer;
	retained_limit integer;
	retained_count bigint;
BEGIN
	SELECT f.owner_id
	INTO owner_key
	FROM public.forms AS f
	WHERE f.id = NEW.form_id
		AND f.disabled_at IS NULL;

	IF owner_key IS NULL OR NOT EXISTS (
		SELECT 1
		FROM public.form_versions AS v
		WHERE v.id = NEW.version_id
			AND v.form_id = NEW.form_id
			AND v.published_at IS NOT NULL
	) THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'forms_collection_closed';
	END IF;

	PERFORM public.lock_form_owner(owner_key);

	IF EXISTS (
		SELECT 1
		FROM public.form_responses AS existing
		WHERE existing.form_id = NEW.form_id
			AND existing.idempotency_key = NEW.idempotency_key
	) THEN
		RETURN NEW;
	END IF;

	response_month := to_char(
		to_timestamp(NEW.created_at::double precision / 1000.0) AT TIME ZONE 'UTC',
		'YYYY-MM'
	);
	SELECT limits.max_monthly_responses, limits.max_retained_responses
	INTO monthly_limit, retained_limit
	FROM public.form_limits AS limits
	WHERE limits.id = 1;

	SELECT usage.response_count
	INTO usage_count
	FROM public.form_monthly_usage AS usage
	WHERE usage.owner_id = owner_key
		AND usage.month = response_month;
	IF COALESCE(usage_count, 0) >= monthly_limit THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'forms_owner_monthly_quota';
	END IF;

	SELECT count(*)
	INTO retained_count
	FROM public.form_responses AS response
	JOIN public.forms AS response_form ON response_form.id = response.form_id
	WHERE response_form.owner_id = owner_key;
	IF retained_count >= retained_limit THEN
		WITH oldest AS (
			SELECT response.id
			FROM public.form_responses AS response
			JOIN public.forms AS response_form ON response_form.id = response.form_id
			WHERE response_form.owner_id = owner_key
			ORDER BY response.created_at ASC, response.id ASC
			LIMIT 1
		)
		DELETE FROM public.form_responses AS response
		USING oldest
		WHERE response.id = oldest.id;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER form_responses_quota_retention_before_insert
BEFORE INSERT ON public.form_responses
FOR EACH ROW
EXECUTE FUNCTION public.guard_form_response_insert();
--> statement-breakpoint
CREATE FUNCTION public.increment_form_monthly_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
	owner_key text;
	response_month text;
BEGIN
	SELECT f.owner_id
	INTO owner_key
	FROM public.forms AS f
	WHERE f.id = NEW.form_id;
	response_month := to_char(
		to_timestamp(NEW.created_at::double precision / 1000.0) AT TIME ZONE 'UTC',
		'YYYY-MM'
	);
	INSERT INTO public.form_monthly_usage (owner_id, month, response_count)
	VALUES (owner_key, response_month, 1)
	ON CONFLICT (owner_id, month)
	DO UPDATE SET response_count = public.form_monthly_usage.response_count + 1;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER form_responses_usage_after_insert
AFTER INSERT ON public.form_responses
FOR EACH ROW
EXECUTE FUNCTION public.increment_form_monthly_usage();
--> statement-breakpoint
CREATE FUNCTION public.guard_form_publish()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	owner_key text;
	max_published integer;
	published_count bigint;
BEGIN
	IF OLD.published_at IS NOT NULL OR NEW.published_at IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT f.owner_id
	INTO owner_key
	FROM public.forms AS f
	WHERE f.id = NEW.form_id
		AND f.disabled_at IS NULL;
	IF owner_key IS NULL THEN
		RETURN NEW;
	END IF;

	PERFORM public.lock_form_owner(owner_key);

	IF EXISTS (
		SELECT 1
		FROM public.form_versions AS existing
		WHERE existing.form_id = NEW.form_id
			AND existing.published_at IS NOT NULL
	) THEN
		RETURN NEW;
	END IF;

	SELECT limits.max_published
	INTO max_published
	FROM public.form_limits AS limits
	WHERE limits.id = 1;
	SELECT count(DISTINCT f.id)
	INTO published_count
	FROM public.forms AS f
	JOIN public.form_versions AS v ON v.form_id = f.id
	WHERE f.owner_id = owner_key
		AND f.disabled_at IS NULL
		AND v.published_at IS NOT NULL;
	IF published_count >= max_published THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'forms_owner_published_limit';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forms_published_cap_before_update
BEFORE UPDATE OF published_at ON public.form_versions
FOR EACH ROW
EXECUTE FUNCTION public.guard_form_publish();
--> statement-breakpoint
CREATE FUNCTION public.tombstone_form_aliases_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
	locked_alias text;
BEGIN
	FOR locked_alias IN
		SELECT aliases.alias
		FROM public.form_aliases AS aliases
		WHERE aliases.form_id = OLD.id
		ORDER BY aliases.alias
	LOOP
		PERFORM public.lock_form_alias(locked_alias);
	END LOOP;

	INSERT INTO public.form_alias_tombstones (alias, created_at)
	SELECT aliases.alias, aliases.created_at
	FROM public.form_aliases AS aliases
	WHERE aliases.form_id = OLD.id
	ON CONFLICT (alias) DO NOTHING;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forms_alias_tombstones_before_delete
BEFORE DELETE ON public.forms
FOR EACH ROW
EXECUTE FUNCTION public.tombstone_form_aliases_before_delete();
