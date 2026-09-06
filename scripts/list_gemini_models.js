const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function main() {
  const models = await ai.models.list();

  for await (const model of models) {
    if (model.name?.includes('gemini')) {
      console.log(model.name);
    }
  }
}

main().catch(error => {
  console.error('Gemini API error:', error.message);
  process.exit(1);
});