# Evaluation

Generated 2026-08-21 10:45 UTC by `scripts/evaluate.py`.

- Split: **dev**
- Documents scored: **17**
- Pairs scored: **85** (one per contract x clause type)
- Gold spans: **182** (CUAD only; lawyer corrections excluded)
- Match rule: token-level F1 >= **0.50** against the best gold span for that pair
- Pairs skipped: **15** (contract present in gold but not yet ingested)

## Headline

| Metric | Value |
|---|---|
| Detection recall | **83.5%** (71/85) |
| Span precision | **70.4%** (81/115) |
| Mean best token F1 | 0.799 |
| Mean gold containment | 0.762 |
| Pairs the system called absent | 9 |
| Pairs with no output at all | 0 |

## By clause type

| Clause type | Pairs | Recall | Span precision | Mean F1 |
|---|---:|---:|---:|---:|
| Anti-Assignment | 17 | 94.1% | 84.0% | 0.957 |
| Cap On Liability | 17 | 64.7% | 75.0% | 0.578 |
| Governing Law | 17 | 88.2% | 69.6% | 0.871 |
| Renewal Term | 17 | 82.4% | 70.8% | 0.799 |
| Termination For Convenience | 17 | 88.2% | 55.6% | 0.788 |

## Match rate by attribution

The model tags each extraction with how it found the text. `not_found` means it could not locate a verbatim span. Human review routes on this signal.

| Attribution | Spans | Match rate | Mean F1 |
|---|---:|---:|---:|
| is_absent=true | 14 | 0.0% | - |
| model | 67 | 77.6% | 0.785 |
| not_found | 24 | 45.8% | 0.509 |
| recovered | 23 | 73.9% | 0.737 |
| spanning | 1 | 100.0% | 1.000 |

## Match rate by self-reported confidence

Confidence is what the model claims about its own output. A flat match rate across bands means the number carries no usable signal, which is why review is not routed on it.

| Confidence band | Spans | Match rate | Mean F1 |
|---|---:|---:|---:|
| 0.50-0.69 | 5 | 0.0% | 0.180 |
| 0.70-0.84 | 12 | 8.3% | 0.294 |
| 0.85-1.00 | 98 | 81.6% | 0.800 |

## How to read these numbers

**Matching is on text, not offsets.** `gold_labels.answer_start` indexes into CUAD's own extraction of the contract; `clauses.char_start` indexes into this pipeline's. The two extractors disagree about whitespace and page furniture, so offsets are not comparable and were not used.

**There are no true negatives.** `prepare_dataset.py` selected contracts that contain all five clause types, so every gold pair is present. This evaluation therefore cannot measure clauses hallucinated where none exist, and does not claim to. Every span the system marked absent is counted as a miss.

**Span precision is not document-level precision.** It answers: of the spans the system asserted, how many actually matched the lawyer-annotated text? A span naming the right clause type but quoting the wrong paragraph counts against it.
