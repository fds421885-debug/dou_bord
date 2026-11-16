import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

interface SolveQuestionBody {
  questionText?: string;
  imageDataUrl?: string;
}

interface AiSolutionPayload {
  finalAnswer: string;
  steps: string[];
  explanation: string;
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.post('/api/solve-question', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: 'مفتاح الذكاء الاصطناعي (GEMINI_API_KEY) غير مضبوط في Settings > Secrets.',
      });
      return;
    }

    const body = (req.body || {}) as SolveQuestionBody;
    const questionText = typeof body.questionText === 'string' ? body.questionText.trim() : '';
    const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';

    if (!questionText && !imageDataUrl) {
      res.status(400).json({
        error: 'يرجى كتابة نص السؤال أو إرفاق صورة أو صفحة PDF أولاً.',
      });
      return;
    }

    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [];

    if (imageDataUrl) {
      const parsed = parseDataUrl(imageDataUrl);
      if (!parsed) {
        res.status(400).json({
          error: 'صيغة الصورة أو صفحة PDF المرسلة غير صالحة.',
        });
        return;
      }
      parts.push({
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.data,
        },
      });
    }

    const promptText = questionText
      ? `السؤال أو الملاحظة المرفقة من المشرف:\n${questionText}\n\nحلّل الصورة أو الصفحة المرفقة (إن وُجدت) مع النص أعلاه، وأعطِ المشرف الإجابة الصحيحة النهائية مع خطوات الحل المفصلة والبسيطة باللغة العربية.`
      : 'حلّل هذه الصورة أو صفحة الـ PDF المرفقة جيداً، واستخرج التمرين/السؤال الموجود فيها، ثم قدّم للمشرف الإجابة الصحيحة النهائية مع شرح طريقة الحل خطوة بخطوة بأسلوب واضح وبسيط ومفصل باللغة العربية.';

    parts.push({ text: promptText });

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction:
            'أنت مساعد ذكي ومعلّم خبير مخصص للمشرف فقط داخل فصل دراسي تفاعلي. مهمتك قراءة السؤال من الصورة أو صفحة PDF أو النص بدقة عالية، وتقديم: (1) الإجابة النهائية الصحيحة بشكل مباشر وواضح، (2) خطوات الحل مرتبة خطوة بخطوة بأسلوب بسيط وسلس ومفصل يناسب الشرح للطلاب، (3) توضيح القاعدة أو الفكرة الأساسية للحل. إذا احتوت الصفحة على عدة مسائل أو فروع، رتّب حل كل فرع بوضوح. التزم باللغة العربية الفصحى السهلة والدقة العلمية التامة.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              finalAnswer: {
                type: Type.STRING,
                description: 'الإجابة النهائية الصحيحة بشكل واضح ومباشر.',
              },
              steps: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'خطوات الحل التفصيلية مرتبة بوضوح وبساطة خطوة بخطوة.',
              },
              explanation: {
                type: Type.STRING,
                description: 'شرح مبسط للفكرة أو القاعدة العلمية ونصيحة سريعة للمشرف عند تقييم حلول الطلاب.',
              },
            },
            required: ['finalAnswer', 'steps', 'explanation'],
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({
          error: 'لم يُرجع الذكاء الاصطناعي نصاً، يرجى المحاولة مرة أخرى.',
        });
        return;
      }

      const parsedJson = JSON.parse(rawText) as Partial<AiSolutionPayload>;
      const result: AiSolutionPayload = {
        finalAnswer:
          typeof parsedJson.finalAnswer === 'string' && parsedJson.finalAnswer.trim()
            ? parsedJson.finalAnswer.trim()
            : 'راجع خطوات الحل أدناه',
        steps: Array.isArray(parsedJson.steps)
          ? parsedJson.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : [],
        explanation:
          typeof parsedJson.explanation === 'string' ? parsedJson.explanation.trim() : '',
      };

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Gemini API error:', msg);

      if (msg.includes('PERMISSION_DENIED') || msg.includes('API_KEY_INVALID') || msg.includes('403')) {
        res.status(403).json({
          error: 'تعذر التحقق من مفتاح Gemini API. يرجى التحقق من المفتاح في لوحة Settings > Secrets.',
        });
        return;
      }
      if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
        res.status(429).json({
          error: 'تم تجاوز حد الطلبات المؤقت للذكاء الاصطناعي. حاول مرة أخرى بعد لحظات.',
        });
        return;
      }

      res.status(500).json({
        error: 'حدث خطأ أثناء تحليل السؤال بالذكاء الاصطناعي، يرجى المحاولة مرة أخرى.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

void createServer();
