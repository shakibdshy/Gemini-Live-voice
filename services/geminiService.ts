
import { GoogleGenAI, Modality } from "@google/genai";

if (!process.env.API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export interface GeminiLiveCallbacks {
    onOpen?: () => void;
    onClose?: (e: CloseEvent) => void;
    onError?: (e: Event) => void;
    onTranscript?: (transcript: string, isFinal: boolean) => void;
    onAudio?: (audioData: string) => void; // base64 string
    onTurnComplete?: () => void;
    onToolCall?: (toolCall: any) => void;
    onToolResponse?: (response: string) => void;
}

// Define available tools for the FM & Accounting Assistant
const tools = [{
    functionDeclarations: [
        {
            name: "calculate_financial_metrics",
            description: "Calculate financial metrics like ROI, NPV, IRR for investment analysis",
            parameters: {
                type: "object",
                properties: {
                    initial_investment: {
                        type: "number",
                        description: "Initial investment amount"
                    },
                    cash_flows: {
                        type: "array",
                        items: { type: "number" },
                        description: "Array of cash flows over time periods"
                    },
                    discount_rate: {
                        type: "number",
                        description: "Discount rate for NPV calculation (as decimal, e.g., 0.1 for 10%)"
                    },
                    metric_type: {
                        type: "string",
                        enum: ["roi", "npv", "irr", "payback_period"],
                        description: "Type of financial metric to calculate"
                    }
                },
                required: ["initial_investment", "cash_flows", "metric_type"]
            }
        },
        {
            name: "generate_financial_report",
            description: "Generate a comprehensive financial report with analysis",
            parameters: {
                type: "object",
                properties: {
                    report_type: {
                        type: "string",
                        enum: ["income_statement", "balance_sheet", "cash_flow", "budget_analysis"],
                        description: "Type of financial report to generate"
                    },
                    period: {
                        type: "string",
                        description: "Time period for the report (e.g., 'Q1 2024', 'FY 2023')"
                    },
                    data: {
                        type: "object",
                        description: "Financial data for report generation"
                    }
                },
                required: ["report_type", "period"]
            }
        },
        {
            name: "budget_tracker",
            description: "Track and analyze budget vs actual spending",
            parameters: {
                type: "object",
                properties: {
                    category: {
                        type: "string",
                        description: "Budget category (e.g., 'marketing', 'operations', 'personnel')"
                    },
                    budgeted_amount: {
                        type: "number",
                        description: "Budgeted amount for the category"
                    },
                    actual_amount: {
                        type: "number",
                        description: "Actual spent amount"
                    },
                    period: {
                        type: "string",
                        description: "Budget period (e.g., 'monthly', 'quarterly', 'annual')"
                    }
                },
                required: ["category", "budgeted_amount", "actual_amount"]
            }
        },
        {
            name: "tax_calculator",
            description: "Calculate tax obligations and deductions",
            parameters: {
                type: "object",
                properties: {
                    income: {
                        type: "number",
                        description: "Total income amount"
                    },
                    deductions: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string" },
                                amount: { type: "number" }
                            }
                        },
                        description: "Array of deduction items"
                    },
                    tax_year: {
                        type: "string",
                        description: "Tax year for calculation"
                    },
                    filing_status: {
                        type: "string",
                        enum: ["single", "married_joint", "married_separate", "head_of_household"],
                        description: "Tax filing status"
                    }
                },
                required: ["income", "tax_year", "filing_status"]
            }
        },
        {
            name: "fetch_general_ledger_report",
            description: "Fetch General Ledger Report data from the accounting system API",
            parameters: {
                type: "object",
                properties: {
                    date_from: {
                        type: "string",
                        description: "Start date for the report (optional, format: YYYY-MM-DD)"
                    },
                    date_to: {
                        type: "string",
                        description: "End date for the report (optional, format: YYYY-MM-DD)"
                    },
                    account_filter: {
                        type: "string",
                        description: "Filter by specific account name (optional)"
                    }
                },
                required: []
            }
        }
    ]
}];

let session: any | null = null;

export const startGeminiLiveSession = async (callbacks: GeminiLiveCallbacks): Promise<void> => {
    if (session) {
        console.log("Session already active.");
        return;
    }

    // Use model that supports function calling
    const model = "gemini-live-2.5-flash-preview";
    const config = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: "You are a professional Financial Management and Accounting Assistant. You help users with financial calculations, budget analysis, tax planning, and generating financial reports. Use the available tools to provide accurate financial insights and calculations. Always explain your calculations and provide actionable advice.",
        tools: tools
    };

    try {
        session = await ai.live.connect({
            model: model,
            config: config as any,
            callbacks: {
                onopen: () => {
                    console.debug('Gemini Live session opened.');
                    callbacks.onOpen?.();
                },
                onclose: (e: CloseEvent) => {
                    console.debug('Gemini Live session closed:', e.reason);
                    callbacks.onClose?.(e);
                    session = null;
                },
                onerror: (e: Event) => {
                    console.error('Gemini Live error:', (e as any).message);
                    callbacks.onError?.(e);
                    session = null;
                },
                onmessage: (message: any) => {
                    if (message.serverContent) {
                        if (message.serverContent.speechToTextResult) {
                            callbacks.onTranscript?.(
                                message.serverContent.speechToTextResult.text,
                                message.serverContent.speechToTextResult.isFinal
                            );
                        }
                        if (message.serverContent.turnComplete) {
                            callbacks.onTurnComplete?.();
                        }
                    }
                    if (message.data) {
                        callbacks.onAudio?.(message.data);
                    }
                    if (message.toolCall) {
                        callbacks.onToolCall?.(message.toolCall);
                        handleToolCall(message.toolCall, callbacks);
                    }
                },
            },
        });
    } catch (error) {
        console.error("Failed to start Gemini Live session:", error);
        throw error;
    }
};

export const sendAudioToGemini = (audioData: string) => {
    if (!session || session.isClosed) {
        // console.warn("Cannot send audio, session is not active.");
        return;
    }
    session.sendRealtimeInput({
        audio: {
            data: audioData,
            mimeType: "audio/pcm;rate=16000"
        }
    });
};

// Tool implementation functions
const calculateFinancialMetrics = (params: any) => {
    const { initial_investment, cash_flows, discount_rate = 0.1, metric_type } = params;
    
    switch (metric_type) {
        case 'roi':
            const totalReturn = cash_flows.reduce((sum: number, cf: number) => sum + cf, 0);
            const roi = ((totalReturn - initial_investment) / initial_investment) * 100;
            return { metric: 'ROI', value: `${roi.toFixed(2)}%`, calculation: `((${totalReturn} - ${initial_investment}) / ${initial_investment}) * 100` };
            
        case 'npv':
            let npv = -initial_investment;
            cash_flows.forEach((cf: number, index: number) => {
                npv += cf / Math.pow(1 + discount_rate, index + 1);
            });
            return { metric: 'NPV', value: `$${npv.toFixed(2)}`, discount_rate: `${(discount_rate * 100).toFixed(1)}%` };
            
        case 'payback_period':
            let cumulativeCashFlow = -initial_investment;
            let paybackPeriod = 0;
            for (let i = 0; i < cash_flows.length; i++) {
                cumulativeCashFlow += cash_flows[i];
                if (cumulativeCashFlow >= 0) {
                    paybackPeriod = i + 1;
                    break;
                }
            }
            return { metric: 'Payback Period', value: `${paybackPeriod} periods`, breakeven: cumulativeCashFlow >= 0 };
            
        default:
            return { error: 'Unsupported metric type' };
    }
};

const generateFinancialReport = (params: any) => {
    const { report_type, period, data } = params;
    
    const reportTemplate = {
        report_type,
        period,
        generated_at: new Date().toISOString(),
        summary: `${report_type.replace('_', ' ').toUpperCase()} for ${period}`,
        status: 'Generated successfully',
        recommendations: [
            'Review monthly variances',
            'Monitor cash flow trends',
            'Optimize expense categories'
        ]
    };
    
    return reportTemplate;
};

const trackBudget = (params: any) => {
    const { category, budgeted_amount, actual_amount, period = 'monthly' } = params;
    
    const variance = actual_amount - budgeted_amount;
    const variancePercentage = (variance / budgeted_amount) * 100;
    
    return {
        category,
        period,
        budgeted_amount: `$${budgeted_amount.toFixed(2)}`,
        actual_amount: `$${actual_amount.toFixed(2)}`,
        variance: `$${variance.toFixed(2)}`,
        variance_percentage: `${variancePercentage.toFixed(1)}%`,
        status: variance > 0 ? 'Over Budget' : variance < 0 ? 'Under Budget' : 'On Budget',
        alert: Math.abs(variancePercentage) > 10 ? 'Significant variance detected' : 'Within acceptable range'
    };
};

const calculateTax = (params: any) => {
    const { income, deductions = [], tax_year, filing_status } = params;
    
    // Simplified tax calculation (2024 tax brackets for demonstration)
    const standardDeduction = {
        'single': 14600,
        'married_joint': 29200,
        'married_separate': 14600,
        'head_of_household': 21900
    };
    
    const totalDeductions = deductions.reduce((sum: number, ded: any) => sum + ded.amount, 0);
    const effectiveDeduction = Math.max(standardDeduction[filing_status as keyof typeof standardDeduction] || 14600, totalDeductions);
    const taxableIncome = Math.max(0, income - effectiveDeduction);
    
    // Simplified tax calculation (approximate)
    let tax = 0;
    if (taxableIncome > 0) {
        tax = taxableIncome * 0.22; // Simplified 22% rate
    }
    
    return {
        tax_year,
        filing_status,
        gross_income: `$${income.toFixed(2)}`,
        total_deductions: `$${effectiveDeduction.toFixed(2)}`,
        taxable_income: `$${taxableIncome.toFixed(2)}`,
        estimated_tax: `$${tax.toFixed(2)}`,
        effective_rate: `${((tax / income) * 100).toFixed(2)}%`
    };
};

const fetchGeneralLedgerReport = async (params: any) => {
    const { date_from, date_to, account_filter } = params;
    
    try {
        // Build query parameters
        const queryParams = new URLSearchParams();
        queryParams.append('companyId', '1');
        if (date_from) queryParams.append('startDate', date_from);
        if (date_to) queryParams.append('endDate', date_to);
        if (account_filter) queryParams.append('account_filter', account_filter);
        
        const url = `${process.env.API_BASE_URL}/accountingreport/general-ledger-report?${queryParams.toString()}`;

        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Process and format the data
        const processedData = {
            report_type: 'General Ledger Report',
            generated_at: new Date().toISOString(),
            total_entries: data.length,
            date_range: {
                from: date_from || 'All dates',
                to: date_to || 'All dates'
            },
            account_filter: account_filter || 'All accounts',
            entries: data.map((entry: any) => ({
                postingDate: entry.postingDate ? new Date(entry.postingDate).toLocaleDateString() : 'N/A',
                account: entry.account || 'Unknown',
                debit: typeof entry.debit === 'number' ? entry.debit.toFixed(2) : '0.00',
                credit: typeof entry.credit === 'number' ? entry.credit.toFixed(2) : '0.00',
                balance: typeof entry.balance === 'number' ? entry.balance.toFixed(2) : '0.00',
                voucherType: entry.voucherType || 'N/A',
                voucherNo: entry.voucherNo || 'N/A'
            })),
            summary: {
                total_debits: data.reduce((sum: number, entry: any) => sum + (entry.debit || 0), 0).toFixed(2),
                total_credits: data.reduce((sum: number, entry: any) => sum + (entry.credit || 0), 0).toFixed(2),
                net_balance: data.reduce((sum: number, entry: any) => sum + (entry.balance || 0), 0).toFixed(2)
            }
        };
        
        return processedData;
        
    } catch (error) {
        console.error('Error fetching General Ledger Report:', error);
        return {
            error: `Failed to fetch General Ledger Report: ${error instanceof Error ? error.message : 'Unknown error'}`,
            report_type: 'General Ledger Report',
            generated_at: new Date().toISOString()
        };
    }
};

// Handle tool calls
const handleToolCall = async (toolCall: any, callbacks: GeminiLiveCallbacks) => {
    const functionResponses = [];
    
    for (const fc of toolCall.functionCalls) {
        let result;
        
        try {
            switch (fc.name) {
                case 'calculate_financial_metrics':
                    result = calculateFinancialMetrics(fc.args);
                    break;
                case 'generate_financial_report':
                    result = generateFinancialReport(fc.args);
                    break;
                case 'budget_tracker':
                    result = trackBudget(fc.args);
                    break;
                case 'tax_calculator':
                    result = calculateTax(fc.args);
                    break;
                case 'fetch_general_ledger_report':
                    result = await fetchGeneralLedgerReport(fc.args);
                    break;
                default:
                    result = { error: `Unknown function: ${fc.name}` };
            }
            
            callbacks.onToolResponse?.(`Tool ${fc.name} executed: ${JSON.stringify(result, null, 2)}`);
            
        } catch (error) {
            result = { error: `Error executing ${fc.name}: ${error}` };
        }
        
        functionResponses.push({
            id: fc.id,
            name: fc.name,
            response: result
        });
    }
    
    // Send tool responses back to Gemini
    if (session && !session.isClosed) {
        await session.sendToolResponse({ functionResponses });
    }
};

export const closeGeminiLiveSession = () => {
    if (session && !session.isClosed) {
        session.close();
        session = null;
    }
};

// Export tool response sender for manual use if needed
export const sendToolResponse = async (functionResponses: any[]) => {
    if (session && !session.isClosed) {
        await session.sendToolResponse({ functionResponses });
    }
};
