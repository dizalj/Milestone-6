# Milestone 6 – Model Testing, Monitoring, and Continual Learning

This repository contains the implementation and supporting artifacts for **Milestone 6** of the *AI for Digital Transformation* course. The project extends the Laddaty ingredient substitution system by integrating real-time model evaluation, online testing, robustness checks, explainability, monitoring, and continual learning strategies.

## Contents

- `Milestone-6-Salih Alj.pdf` — Full project report with detailed methodology and results.
- `abTesting.js` — ingredientService code with A/B testing, performance monitoring, and explainability.
- `drift.ipynb` — Data drift analysis using the Evidently framework.
- `ingredient_substitutes.csv` — Sample dataset used for evaluation.

## Highlights

- **Live Evaluation**: Real-world usage logs were used to compute Hit@1 and Hit@5 metrics.
- **A/B Testing**: Implemented dynamic model routing and comparison based on latency and response quality.
- **Bias & Robustness Audits**: Evaluated cultural alignment and model behavior on rare or low-substitution scenarios.
- **Explainability**: Prompt transparency and LLM-based self-rationalization.
- **Monitoring**: Integrated Prometheus and Grafana for latency and error tracking.
- **Continual Learning**: Prompt-based CT/CD flow using recent feedback logs.
- **Pipeline**: Modular Express-based orchestration with CI/CD integration.

## Tools Used

- LLMs via OpenRouter (Qwen2.5, GPT-4o)
- MongoDB, Express.js
- Prometheus + Grafana
- Evidently for drift detection

---

> Prepared by **Khadija Salih Alj**  
> Supervised by **Dr. Asmaa Mourhir**
