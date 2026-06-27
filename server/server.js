require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function web_search(query) {
  console.log('Searching:', query);
  try {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: process.env.TAVILY_API_KEY,
      query: query,
      max_results: 8
    });
    return JSON.stringify(response.data.results.map(r => ({
      title: r.title,
      url: r.url,
      content: r.content
    })));
  } catch (error) {
    return `Search failed: ${error.message}`;
  }
}

function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search for job listings on the web',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Job search query' }
        },
        required: ['query']
      }
    }
  }
];

app.post('/api/search', async (req, res) => {
  const { jobTitle, location, experience } = req.body;

  if (!jobTitle) {
    return res.status(400).json({ error: 'Job title is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  console.log(`Searching for ${jobTitle} in ${location}`);

  const messages = [
    {
      role: 'system',
      content: `You are a job search assistant. Search for real job listings and return them as a JSON array.

After searching, return ONLY a valid JSON array like this — no extra text, no markdown, just the array:
[
  {
    "title": "Job Title",
    "company": "Company Name",
    "location": "City, Country",
    "salary": "Salary range or Not specified",
    "description": "2 sentence description of the role",
    "url": "https://actual-job-url.com",
    "source": "LinkedIn / Indeed / Glassdoor"
  }
]

Return at least 5 jobs. Only include real job listings with actual URLs.`
    },
    {
      role: 'user',
      content: `Search for ${jobTitle} jobs${location ? ` in ${location}` : ''}${experience ? ` with ${experience} experience` : ''}. 
Search multiple sources like LinkedIn, Indeed, Glassdoor, and Bayt.
Return the results as a JSON array.`
    }
  ];

  try {
    sendEvent(res, {
      type: 'thinking',
      message: `Searching for ${jobTitle} jobs${location ? ` in ${location}` : ''}...`
    });

    let iteration = 0;
    let searchCount = 0;
    const maxIterations = 6;

    while (iteration < maxIterations) {
      iteration++;

      const response = await groq.chat.completions.create({
        model: 'llama3-groq-70b-8192-tool-use-preview',
        messages: messages,
        tools: searchCount < 2 ? tools : undefined,
        tool_choice: searchCount < 2 ? 'auto' : undefined,
        max_tokens: 4096,
        temperature: 0.3
      });

      const message = response.choices[0].message;
      messages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const parsedArgs = JSON.parse(toolCall.function.arguments);
          searchCount++;

          sendEvent(res, {
            type: 'searching',
            message: `Searching: ${parsedArgs.query}`
          });

          const result = await web_search(parsedArgs.query);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
        }

        if (searchCount >= 2) {
          messages.push({
            role: 'user',
            content: `Now return the job listings you found as a clean JSON array only. No explanation, no markdown, just the JSON array starting with [ and ending with ].`
          });
        }

        continue;
      }

      if (message.content) {
        try {
          const cleaned = message.content
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();

          const start = cleaned.indexOf('[');
          const end = cleaned.lastIndexOf(']');

          if (start !== -1 && end !== -1) {
            const jsonStr = cleaned.slice(start, end + 1);
            const jobs = JSON.parse(jsonStr);
            sendEvent(res, { type: 'results', jobs: jobs });
            break;
          } else {
            sendEvent(res, { type: 'error', message: 'Could not parse job results' });
            break;
          }
        } catch (e) {
          sendEvent(res, { type: 'error', message: 'Failed to parse results' });
          break;
        }
      }

      break;
    }

    res.end();

  } catch (error) {
    console.error('Search error:', error.message);
    sendEvent(res, { type: 'error', message: error.message });
    res.end();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
