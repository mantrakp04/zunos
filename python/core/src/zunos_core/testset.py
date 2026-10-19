# The 13 held-back clips from the first recording session (final ids from data/final/transcripts.jsonl).
# Never train on them. In the app they are clips with split='test'; this list is only for importing
# the legacy data and for scoring the legacy model from the command line.
LEGACY_TEST = frozenset({
    "para-en-02", "para-en-05", "para-en-07", "twister-05-en-31",
    "para-hi-11", "para-hi-12", "para-hi-13", "para-hi-15", "twister-08-hi-34",
    "para-gu-19", "para-gu-22", "para-gu-23", "para-gu-24",
})
