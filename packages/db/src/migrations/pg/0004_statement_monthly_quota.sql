CREATE OR REPLACE FUNCTION public.guard_form_response_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	owner_key text;
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

	SELECT limits.max_retained_responses
	INTO retained_limit
	FROM public.form_limits AS limits
	WHERE limits.id = 1;

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
CREATE OR REPLACE FUNCTION public.increment_form_monthly_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
	usage_group record;
	monthly_limit integer;
	usage_count integer;
BEGIN
	SELECT limits.max_monthly_responses
	INTO monthly_limit
	FROM public.form_limits AS limits
	WHERE limits.id = 1;

	FOR usage_group IN
		SELECT
			form.owner_id AS owner_id,
			to_char(
				to_timestamp(response.created_at::double precision / 1000.0) AT TIME ZONE 'UTC',
				'YYYY-MM'
			) AS month,
			count(*)::integer AS accepted_count
		FROM inserted_rows AS response
		JOIN public.forms AS form ON form.id = response.form_id
		GROUP BY
			form.owner_id,
			to_char(
				to_timestamp(response.created_at::double precision / 1000.0) AT TIME ZONE 'UTC',
				'YYYY-MM'
			)
		ORDER BY form.owner_id, month
	LOOP
		INSERT INTO public.form_monthly_usage (owner_id, month, response_count)
		VALUES (usage_group.owner_id, usage_group.month, usage_group.accepted_count)
		ON CONFLICT (owner_id, month)
		DO UPDATE SET response_count = public.form_monthly_usage.response_count + EXCLUDED.response_count
		RETURNING response_count INTO usage_count;

		IF usage_count > monthly_limit THEN
			RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'forms_owner_monthly_quota';
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER form_responses_usage_after_insert ON public.form_responses;
--> statement-breakpoint
CREATE TRIGGER form_responses_usage_after_insert
AFTER INSERT ON public.form_responses
REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.increment_form_monthly_usage();
