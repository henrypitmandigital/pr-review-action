"""Read-only compatibility checks against the exact v0.46.0 source, no imports/inference.

Usage: compatibility.py <pr-agent-source> [.pr_agent.toml] [config.json]
"""
from pathlib import Path
import json
import subprocess
import sys
import tomllib

source = Path(sys.argv[1])
sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
assert sha == '1d01f24f455bb879c1d9c557ad7de3d72dcc7975', 'Unexpected PR-Agent source'
settings = tomllib.loads((source / 'pr_agent/settings/configuration.toml').read_text())
# The caller's .pr_agent.toml is optional; when present it must use only native
# keys and agree with the repository's PR-review config.
toml_path = Path(sys.argv[2] if len(sys.argv) > 2 else '.pr_agent.toml')
config = json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else None
if toml_path.exists():
    local = tomllib.loads(toml_path.read_text())
    for section, values in local.items():
        assert section in settings, section
        for key, value in values.items():
            assert key in settings[section], f'Unsupported {section}.{key}'
            assert isinstance(value, type(settings[section][key])), f'Wrong type {section}.{key}'
    assert local.get('config', {}).get('fallback_models', []) == [], 'fallback_models must be []'
    if config:
        model = local.get('config', {}).get('model')
        assert model in (None, 'openrouter/' + config['baseline']['model']), 'model differs from config baseline'
        if config['baseline'].get('reasoning', 'off') == 'off':
            openrouter = local.get('openrouter', {})
            assert openrouter.get('reasoning_effort', 'none') == 'none', 'reasoning_effort conflicts with baseline reasoning off'
            assert openrouter.get('reasoning_max_tokens', 0) == 0, 'reasoning_max_tokens conflicts with baseline reasoning off'
        output = config.get('challenger', {}).get('output_tokens', 8192)
        for section, key in [('openrouter', 'max_tokens'), ('config', 'max_output_tokens')]:
            value = local.get(section, {}).get(key)
            assert value in (None, output), f'{section}.{key} differs from config output_tokens'
runner = (source / 'pr_agent/servers/github_action_runner.py').read_text()
handler = (source / 'pr_agent/algo/ai_handlers/litellm_ai_handler.py').read_text()
auth = (source / 'pr_agent/algo/ai_handlers/cloud_auth.py').read_text()
provider = (source / 'pr_agent/git_providers/github_provider.py').read_text()
reviewer = (source / 'pr_agent/tools/pr_reviewer.py').read_text()
for key in ['AUTO_REVIEW', 'AUTO_DESCRIBE', 'AUTO_IMPROVE', 'HANDLE_PUSH_TRIGGER', 'REVIEW_COMMANDS']:
    assert key.lower() in runner.lower(), key
assert "os.environ.get('GITHUB_TOKEN')" in runner
assert 'OPENROUTER_API_KEY' in auth
assert 'reasoning["max_tokens"] = reasoning_max_tokens' in handler
assert 'reasoning_effort = "none" keeps reasoning disabled' in (source / 'pr_agent/settings/configuration.toml').read_text()
assert 'show_run_details' in reviewer and 'output_run_details' in reviewer
assert 'self.repo_obj.get_contents(".pr_agent.toml")' in provider
assert 'get_config_branch()' in provider
print('PR-Agent v0.46.0: routing, native configuration keys, credentials and run-details compatible')
