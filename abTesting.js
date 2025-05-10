const axios = require('axios');
const stringSimilarity = require('string-similarity');
const Ingredient = require('../models/Ingredient');
const apiKey = process.env.API_KEY;
const SubstitutionLog = require('../models/SubstitutionLog');
let ingredientNames = [];
let ingredientData = {};
let isIngredientsLoaded = false;

const client = require('prom-client');


// Summary to track latency per model
const Latency = new client.Summary({
    name: 'latency_ms',
    help: 'Latency of substitution generation',
    labelNames: ['model'],
    percentiles: [0.5, 0.9, 0.99]
});

const RequestLatency = new client.Gauge({
    name: 'single_request_latency_ms',
    help: 'Latency of each substitute generation request in ms',
    labelNames: ['model']
});

// Counter to track errors per model
const Errors = new client.Counter({
    name: 'error_count',
    help: 'Errors from substitution LLM',
    labelNames: ['model'],
});

async function loadIngredients() {
    if (!isIngredientsLoaded) {
        const ingredients = await Ingredient.find({}, { name: 1, image: 1, nutrition: 1, notAllowedIn: 1 }).lean();
        ingredientNames = ingredients.map(doc => doc.name?.en?.toLowerCase()).filter(Boolean);

        ingredientData = ingredients.reduce((acc, doc) => {
            const key = doc.name?.en?.toLowerCase();
            if (key) {
                acc[key] = {
                    name: doc.name,
                    image: doc.image,
                    nutrition: doc.nutrition || {},
                    notAllowedIn: doc.notAllowedIn
                };
            }
            return acc;
        }, {});
        isIngredientsLoaded = true;
    }
}

function findClosestMatch(ingredient) {
    if (!ingredient || typeof ingredient !== "string") return null;
    const match = stringSimilarity.findBestMatch(ingredient.toLowerCase(), ingredientNames);
    return match?.bestMatch?.rating > 0.77 ? match.bestMatch.target : null;
}

function removeParentheses(text) {
    return text.replace(/\s*\(.*?\)\s*/g, '').trim();
}

function getIngredientData(ingredient) {
    return ingredientData[ingredient.toLowerCase()] || { image: null, nutrition: {}, notAllowedIn: [] };
}

async function generateSubstitutionExplanation(original, substitute, recipeContext) {
    const prompt = `
        Explain why "${substitute}" is a good replacement for "${original}" in this recipe:
        ${recipeContext}
        Return a short, clear explanation for culinary users in max 2 sentences.
    `;

    try {
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "qwen/qwen-2.5-7b-instruct",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const content = response.data?.choices?.[0]?.message?.content?.trim();
        return content || "No explanation available.";
    } catch (err) {
        console.error("❌ Error generating explanation:", err.message);
        return "No explanation available due to error.";
    }
}

function buildFewShotPromptExamples(substitutionLogs, maxExamples = 3) {
    const fewShotExamples = [];

    for (const entry of substitutionLogs) {
        const ingredient = entry.ingredient;
        const recipe = entry.recipeContext?.trim().replace(/\s+/g, ' ');
        const substitutes = entry.generatedSubstitutes || [];

        const picked = substitutes.find(s => s.picked === 1);
        if (!picked || !picked.name?.en || !picked.ratio) continue;

        fewShotExamples.push([
            `Ingredient: ${ingredient}`,
            `Recipe: ${recipe.slice(0, 400)}...`,
            `Picked Substitute: ${picked.name.en}`,
            `Ratio: ${picked.ratio}`
        ].join('\n'));

        if (fewShotExamples.length >= maxExamples) break;
    }

    return fewShotExamples.join('\n\n');
}


async function updateStepForSubstitution(originalStep, originalIng, substituteIng, locale) {
    const prompt = `
        You are rewriting a cooking instruction step for a recipe in this language: "${locale}".

        Original step:
        "${originalStep}"

        The ingredient "${originalIng}" has been replaced with "${substituteIng}".

        Your task:
        - Rewrite the step so it makes sense with the new ingredient in the specified language.
        - Use the imperative form (e.g., Mix, Chop, Bake). If the language is French, utilisez l'impératif (e.g., Mélangez, Coupez, Faites cuire).
        - Make sure the action suits the substitute.
        - Keep it short and natural.
        - Do NOT mention "${originalIng}" at all.

        Return ONLY a JSON object like this:
        {
        "title": "Short step title (action-based)",
        "description": "Rewritten step using the substitute ingredient"
        }
        Make sure it's valid JSON. No explanation, no formatting, no notes.
    `;

    try {
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "qwen/qwen-2.5-7b-instruct",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                }
            }
        );

        let content = response.data?.choices?.[0]?.message?.content?.trim();
        if (!content) return { title: "", description: originalStep };

        // Try parsing JSON
        try {
            const parsed = JSON.parse(content);
            return {
                title: parsed.title?.trim() || "",
                description: parsed.description?.trim() || originalStep
            };
        } catch (jsonErr) {
            console.warn("⚠️ Fallback: Could not parse JSON. Raw content:", content);

            // Attempt extracting manually if JSON failed
            const titleMatch = content.match(/"title"\s*:\s*"(.*?)"/);
            const descMatch = content.match(/"description"\s*:\s*"(.*?)"/);
            return {
                title: titleMatch?.[1]?.trim() || "",
                description: descMatch?.[1]?.trim() || originalStep
            };
        }
    } catch (err) {
        console.error("❌ Error rewriting step:", err.message);
        return { title: "", description: originalStep };
    }
}

async function matchSubstitutes(aiSubstitutes) {
    const matched = new Set();
    for (const sub of aiSubstitutes) {
        const closestMatch = findClosestMatch(sub);
        if (closestMatch && !matched.has(closestMatch)) matched.add(closestMatch);
    }
    return [...matched].slice(0, 10);
}

const selectedModel = "qwen/qwen-2.5-7b-instruct"; // or A/B test here
const endTimer = Latency.startTimer({ model: selectedModel });

async function generateSubstitute(ingredient, recipe) {
    const start = Date.now();
    const logs = await SubstitutionLog.find({ picked: 1 }).lean();

    const fewShot = buildFewShotPromptExamples(logs);

    const prompt =
        `${fewShot}
        Suggest the best 10 substitutes for "${ingredient}" in this recipe "${recipe}", depending on the role it plays in it (look at quantity and how used in steps).
        For each substitute, provide:
        1. Ensure that the ratio provided can logically be applied **in both directions**.
        Provide the response in strict JSON format with:
        {
            "substitutes": [
                {"name": "Substitute Name", "ratio": "Substitution ratio as a decimal number"}
            ]
        }`;
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
        try {
            const response = await axios.post(
                "https://openrouter.ai/api/v1/chat/completions",
                {
                    model: selectedModel,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            const rawContent = response.data?.choices?.[0]?.message?.content;
            console.log(rawContent)
            if (!rawContent) throw new Error("No content in response");
            let content;
            try {
                content = JSON.parse(rawContent);
            } catch (e) {
                const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Invalid JSON format in model response");
                try {
                    content = JSON.parse(jsonMatch[0]);
                } catch (jsonErr) {
                    console.error("JSON parsing failed:", jsonMatch[0]);
                    throw new Error("Failed to parse JSON from matched block");
                }
            }
            console.log(content)
            endTimer();
            const durationMs = Date.now() - start;
            RequestLatency.set({ model: selectedModel }, durationMs);
            return (content.substitutes || [])
                .filter(s => s.name && s.ratio)
                .map(s => ({
                    name: s.name.trim(),
                    ratio: parseFloat(s.ratio.toString().match(/[\d.]+/g)?.[0])
                }))
                .filter(s => s.ratio);

        } catch (error) {
            retryCount++;
            console.error(`Retry ${retryCount}:`, error.message);
            if (retryCount >= maxRetries) {
                Errors.inc({ model: selectedModel });
                endTimer();
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    return [];
}

async function getSubstitutes(ingredient, recipe) {
    await loadIngredients();
    const closestMatch = findClosestMatch(ingredient);
    if (!closestMatch) return { ingredient: null, substitutes: [] };

    const doc = await Ingredient.findOne({ name: closestMatch }, { substitutes: 1 }).lean();
    const substitutes = doc?.substitutes || [];

    if (substitutes.length > 0) {
        return {
            ingredient: closestMatch,
            substitutes: substitutes.slice(0, 10).map(sub => ({
                name: sub,
                ...getIngredientData(sub),
            })),
        };
    }

    const aiSubstitutes = await generateSubstitute(closestMatch, recipe);
    const cleanedNames = aiSubstitutes.map(s => removeParentheses(s.name));
    const matched = await matchSubstitutes(cleanedNames);
    const ratioMap = Object.fromEntries(
        aiSubstitutes.map(s => [removeParentheses(s.name).toLowerCase(), s.ratio])
    );

    const filtered = matched.filter(name =>
        name.toLowerCase() !== closestMatch.toLowerCase()
    );

    return {
        ingredient: closestMatch,
        substitutes: filtered.map(name => ({
            name,
            quantity: ratioMap[name.toLowerCase()],
            ...getIngredientData(name),
        }))
    };

}

module.exports = { getSubstitutes, updateStepForSubstitution, generateSubstitutionExplanation };