"""Metadata-only observer around the pinned PR-Agent CLI; never another reviewer."""
import json
import os
from pathlib import Path
import time

FINISH_REASONS = {'stop', 'length', 'tool_calls', 'function_call', 'content_filter'}
ERROR_NAMES = {'APIError', 'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'RateLimitError', 'APITimeoutError', 'APIConnectionError', 'TimeoutError'}


def field(value, key, default=None):
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100000000 else None


def response_metadata(response):
    choices = field(response, 'choices', []) or []
    choice = choices[0] if choices else {}
    message = field(choice, 'message', {}) or {}
    content = field(message, 'content')
    finish = field(choice, 'finish_reason')
    usage = field(response, 'usage', {}) or {}
    details = field(usage, 'completion_tokens_details', {}) or {}
    return {
        'finish_reason': finish if isinstance(finish, str) and finish in FINISH_REASONS else 'unknown',
        'content_chars': len(content) if isinstance(content, str) else 0,
        'prompt_tokens': count(field(usage, 'prompt_tokens')),
        'completion_tokens': count(field(usage, 'completion_tokens')),
        'reasoning_tokens': count(field(details, 'reasoning_tokens')),
    }


def error_metadata(error):
    name = type(error).__name__
    status = field(error, 'status_code')
    return {'error_category': name if name in ERROR_NAMES else 'upstream_error',
            'http_status': status if isinstance(status, int) and 100 <= status <= 599 else None}


def run():
    import pr_agent.cli as cli
    import pr_agent.tools.pr_reviewer as reviewer
    import pr_agent.algo.ai_handlers.litellm_ai_handler as handler
    from pr_agent.algo.pr_processing import PreparedPRDiff
    from pr_agent.config_loader import get_settings

    path = Path(os.environ['PR_REVIEW_DIAGNOSTICS_PATH'])
    report = {'schema': 1, 'attempts': [], 'coverage': []}

    def save():
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report), encoding='utf8')
        temporary.replace(path)

    original_diff = reviewer.get_pr_diff

    def observed_diff(*args, **kwargs):
        result = original_diff(*args, **kwargs)
        if isinstance(result, PreparedPRDiff):
            text, omitted = result.diff, result.remaining_files_list
        elif isinstance(result, tuple):
            text, omitted = result[0], result[1]
        else:
            text, omitted = result, []
        provider, tokens = args[:2]
        report['coverage'].append({'files': len(provider.get_diff_files()),
                                  'omitted_files': len(omitted),
                                  'prepared_tokens': tokens.prompt_tokens + tokens.count_tokens(text)})
        save()
        return result

    reviewer.get_pr_diff = observed_diff
    original_completion = handler.acompletion

    async def observed_completion(*args, **kwargs):
        if len(report['attempts']) >= 2:
            raise RuntimeError('Observed review request budget exhausted')
        started = time.monotonic()
        attempt = {'state': 'started', 'output_limit': count(kwargs.get('max_tokens', kwargs.get('max_completion_tokens')))}
        report['attempts'].append(attempt)
        save()
        try:
            response = await original_completion(*args, **kwargs)
            if kwargs.get('stream'):
                # Native handler assembles stream content/usage; observe its final
                # response in the separate streaming hook below.
                attempt['state'] = 'streaming'
            else:
                attempt.update(response_metadata(response))
                attempt['state'] = 'completed'
            return response
        except Exception as error:
            attempt.update(error_metadata(error))
            attempt['state'] = 'failed'
            raise
        finally:
            attempt['elapsed_ms'] = round((time.monotonic() - started) * 1000)
            save()

    handler.acompletion = observed_completion
    original_stream = handler._handle_streaming_response

    async def observed_stream(response, *args, **kwargs):
        attempt = report['attempts'][-1]

        async def chunks():
            async for chunk in response:
                metadata = response_metadata(chunk)
                for key, value in metadata.items():
                    if key != 'content_chars' and value is not None and value != 'unknown':
                        attempt[key] = value
                choices = field(chunk, 'choices', []) or []
                delta = field(choices[0], 'delta', {}) if choices else {}
                content = field(delta, 'content')
                if isinstance(content, str):
                    attempt['content_chars'] = attempt.get('content_chars', 0) + len(content)
                save()
                yield chunk

        try:
            result = await original_stream(chunks(), *args, **kwargs)
            attempt.update(response_metadata(result[2]))
            attempt['state'] = 'completed'
            return result
        except Exception as error:
            attempt.update(error_metadata(error))
            attempt['state'] = 'failed'
            raise
        finally:
            save()

    handler._handle_streaming_response = observed_stream
    settings = get_settings()
    report['limits'] = {'input': count(settings.config.custom_model_max_tokens),
                        'output': count(settings.config.max_output_tokens),
                        'reasoning': count(settings.openrouter.reasoning_max_tokens)}
    save()
    return cli.run()


if __name__ == '__main__':
    raise SystemExit(run())
