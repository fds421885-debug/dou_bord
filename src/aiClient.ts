/// <reference types="vite/client" />
import { GoogleGenAI, Type } from '@google/genai';

declare const __GEMINI_API_KEY__: string | undefined;

export interface AiSolution {
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

function getEmbeddedApiKey(): string {
  const fromViteEnv =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)
      : '';
  const fromDefine =
    typeof __GEMINI_API_KEY__ !== 'undefined' ? __GEMINI_API_KEY__ : '';
  return (fromViteEnv || fromDefine || '').trim();
}

export async function solveQuestionWithAi(
  questionText: string,
  imageDataUrl: string
): Promise<AiSolution> {
  const apiKey = getEmbeddedApiKey();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'مفتاح الذكاء الاصطناعي غير مضبوط. أضف VITE_GEMINI_API_KEY أو GEMINI_API_KEY في متغيرات البيئة (Netlify أو Settings > Secrets).'
    );
  }

  const cleanText = questionText.trim();
  const cleanImage = imageDataUrl.trim();
  if (!cleanText && !cleanImage) {
    throw new Error('يرجى كتابة نص السؤال أو إرفاق صورة أو صفحة PDF أولاً.');
  }

  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

  if (cleanImage) {
    const parsed = parseDataUrl(cleanImage);
    if (!parsed) {
      throw new Error('صيغة الصورة أو صفحة PDF المرفقة غير صالحة.');
    }
    parts.push({
      inlineData: {
        mimeType: parsed.mimeType,
        data: parsed.data,
      },
    });
  }

  const promptText = cleanText
    ? `السؤال أو الملاحظة المرفقة من المشرف:\n${cleanText}\n\nحلّل الصورة أو الصفحة المرفقة (إن وُجدت) مع النص أعلاه، وأعطِ المشرف الإجابة الصحيحة النهائية مع خطوات الحل المفصلة والبسيطة باللغة العربية.`
    : 'حلّل هذه الصورة أو صفحة الـ PDF المرفقة جيداً، واستخرج التمرين/السؤال الموجود فيها، ثم قدّم للمشرف الإجابة الصحيحة النهائية مع شرح طريقة الحل خطوة بخطوة بأسلوب واضح وبسيط ومفصل باللغة العربية.';

  parts.push({ text: promptText });

  try {
    const ai = new GoogleGenAI({ apiKey });

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
              description:
                'شرح مبسط للفكرة أو القاعدة العلمية ونصيحة سريعة للمشرف عند تقييم حلول الطلاب.',
            },
          },
          required: ['finalAnswer', 'steps', 'explanation'],
        },
      },
    });

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      throw new Error('لم يُرجع الذكاء الاصطناعي نصاً، يرجى المحاولة مرة أخرى.');
    }

    const parsedJson = JSON.parse(rawText) as Partial<AiSolution>;
    return {
      finalAnswer:
        typeof parsedJson.finalAnswer === 'string' && parsedJson.finalAnswer.trim()
          ? parsedJson.finalAnswer.trim()
          : 'راجع خطوات الحل أدناه',
      steps: Array.isArray(parsedJson.steps)
        ? parsedJson.steps.filter(
            (s): s is string => typeof s === 'string' && s.trim().length > 0
          )
        : [],
      explanation:
        typeof parsedJson.explanation === 'string'
          ? parsedJson.explanation.trim()
          : '',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('API_KEY_INVALID') ||
      msg.includes('403')
    ) {
      throw new Error(
        'تعذر التحقق من مفتاح Gemini API. يرجى التحقق من المفتاح في متغيرات البيئة (Netlify أو Settings > Secrets).'
      );
    }
    if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
      throw new Error(
        'تم تجاوز حد الطلبات المؤقت للذكاء الاصطناعي. حاول مرة أخرى بعد لحظات.'
      );
    }
    if (
      msg.includes('مفتاح الذكاء الاصطناعي') ||
      msg.includes('يرجى كتابة') ||
      msg.includes('صيغة الصورة') ||
      msg.includes('لم يُرجع الذكاء الاصطناعي')
    ) {
      throw err;
    }
    throw new Error(
      'حدث خطأ أثناء تحليل السؤال بالذكاء الاصطناعي، يرجى المحاولة مرة أخرى.'
    );
  }
}
