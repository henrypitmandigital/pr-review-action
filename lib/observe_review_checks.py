import unittest
from observe_review import response_metadata, error_metadata


class MetadataTests(unittest.TestCase):
    def test_empty_length_response_retains_usage_without_content(self):
        result = response_metadata({'choices': [{'finish_reason': 'length', 'message': {'content': '', 'reasoning_content': 'PRIVATE'}}], 'usage': {'prompt_tokens': 12000, 'completion_tokens': 4096, 'completion_tokens_details': {'reasoning_tokens': 4096}}})
        self.assertEqual(result['finish_reason'], 'length')
        self.assertEqual(result['content_chars'], 0)
        self.assertEqual(result['reasoning_tokens'], 4096)
        self.assertNotIn('PRIVATE', str(result))

    def test_provider_values_cannot_become_diagnostics_text(self):
        result = response_metadata({'choices': [{'finish_reason': 'SECRET', 'message': {'content': 'PRIVATE'}}], 'usage': {'prompt_tokens': -1, 'completion_tokens': True}})
        self.assertEqual(result['finish_reason'], 'unknown')
        self.assertEqual(result['content_chars'], 7)
        self.assertIsNone(result['prompt_tokens'])
        self.assertIsNone(result['completion_tokens'])
        self.assertNotIn('PRIVATE', str(result))
        self.assertNotIn('SECRET', str(result))
        error = Exception('API KEY AND PROMPT')
        self.assertEqual(error_metadata(error)['error_category'], 'upstream_error')
        self.assertNotIn('API KEY', str(error_metadata(error)))


if __name__ == '__main__':
    unittest.main()
