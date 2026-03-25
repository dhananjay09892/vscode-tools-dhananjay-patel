export interface DevpilotAgentProfile {
  id: string;
  group: 'engineering' | 'product' | 'marketing' | 'design' | 'project-management' | 'studio-operations' | 'testing';
  title: string;
  purpose: string;
  responsibilities: string[];
}

export const ALL_DEVPILOT_AGENTS: DevpilotAgentProfile[] = [
  {
    id: 'frontend-developer',
    group: 'engineering',
    title: 'Frontend Developer',
    purpose: 'Implements UI flows and client-side architecture changes.',
    responsibilities: ['Component architecture', 'State management', 'Accessibility and UX polish']
  },
  {
    id: 'backend-architect',
    group: 'engineering',
    title: 'Backend Architect',
    purpose: 'Designs robust APIs and backend services.',
    responsibilities: ['API contracts', 'Data models', 'Reliability and scalability']
  },
  {
    id: 'mobile-app-builder',
    group: 'engineering',
    title: 'Mobile App Builder',
    purpose: 'Shapes mobile app implementation and release readiness.',
    responsibilities: ['Platform-specific UX', 'Mobile performance', 'Store readiness']
  },
  {
    id: 'ai-engineer',
    group: 'engineering',
    title: 'AI Engineer',
    purpose: 'Builds and validates model-assisted product capabilities.',
    responsibilities: ['Prompt design', 'Model evaluation', 'Safety and guardrails']
  },
  {
    id: 'devops-automator',
    group: 'engineering',
    title: 'DevOps Automator',
    purpose: 'Automates delivery pipelines and runtime operations.',
    responsibilities: ['CI and CD workflows', 'Infrastructure automation', 'Release hardening']
  },
  {
    id: 'rapid-prototyper',
    group: 'engineering',
    title: 'Rapid Prototyper',
    purpose: 'Quickly validates ideas with low-friction prototypes.',
    responsibilities: ['MVP slicing', 'Fast iteration', 'Demo-ready artifacts']
  },
  {
    id: 'trend-researcher',
    group: 'product',
    title: 'Trend Researcher',
    purpose: 'Finds strategic opportunities from market and product signals.',
    responsibilities: ['Trend scans', 'Competitor analysis', 'Opportunity framing']
  },
  {
    id: 'feedback-synthesizer',
    group: 'product',
    title: 'Feedback Synthesizer',
    purpose: 'Converts user feedback into clear product direction.',
    responsibilities: ['Signal clustering', 'Pain-point ranking', 'Actionable recommendations']
  },
  {
    id: 'sprint-prioritizer',
    group: 'product',
    title: 'Sprint Prioritizer',
    purpose: 'Builds balanced sprint plans grounded in impact and effort.',
    responsibilities: ['Backlog ordering', 'Risk-aware tradeoffs', 'Sprint scoping']
  },
  {
    id: 'tiktok-strategist',
    group: 'marketing',
    title: 'TikTok Strategist',
    purpose: 'Creates growth strategies for short-form video channels.',
    responsibilities: ['Channel strategy', 'Content hooks', 'Experiment loops']
  },
  {
    id: 'instagram-curator',
    group: 'marketing',
    title: 'Instagram Curator',
    purpose: 'Plans cohesive Instagram campaigns and visual storytelling.',
    responsibilities: ['Campaign themes', 'Visual cadence', 'Engagement mechanics']
  },
  {
    id: 'twitter-engager',
    group: 'marketing',
    title: 'Twitter Engager',
    purpose: 'Drives conversation-based growth on X or Twitter.',
    responsibilities: ['Thread strategies', 'Community conversation', 'Realtime engagement']
  },
  {
    id: 'reddit-community-builder',
    group: 'marketing',
    title: 'Reddit Community Builder',
    purpose: 'Builds trust-first growth strategies for community forums.',
    responsibilities: ['Subreddit mapping', 'Trust-safe promotion', 'Conversation seeding']
  },
  {
    id: 'app-store-optimizer',
    group: 'marketing',
    title: 'App Store Optimizer',
    purpose: 'Improves app discovery and conversion in app stores.',
    responsibilities: ['ASO keywords', 'Listing optimization', 'Rating and review strategy']
  },
  {
    id: 'content-creator',
    group: 'marketing',
    title: 'Content Creator',
    purpose: 'Produces audience-aligned content plans across channels.',
    responsibilities: ['Editorial planning', 'Message framing', 'Content repurposing']
  },
  {
    id: 'growth-hacker',
    group: 'marketing',
    title: 'Growth Hacker',
    purpose: 'Designs high-velocity growth experiments with clear metrics.',
    responsibilities: ['Experiment design', 'Activation improvements', 'Retention loops']
  },
  {
    id: 'ui-designer',
    group: 'design',
    title: 'UI Designer',
    purpose: 'Defines effective visual systems for product interfaces.',
    responsibilities: ['Layout systems', 'Visual hierarchy', 'Design consistency']
  },
  {
    id: 'ux-researcher',
    group: 'design',
    title: 'UX Researcher',
    purpose: 'Uncovers user behavior and usability issues.',
    responsibilities: ['Research plans', 'Usability insights', 'Journey mapping']
  },
  {
    id: 'brand-guardian',
    group: 'design',
    title: 'Brand Guardian',
    purpose: 'Protects brand consistency across artifacts and channels.',
    responsibilities: ['Tone validation', 'Visual consistency checks', 'Brand guideline enforcement']
  },
  {
    id: 'visual-storyteller',
    group: 'design',
    title: 'Visual Storyteller',
    purpose: 'Builds narrative clarity through visual communication.',
    responsibilities: ['Narrative framing', 'Presentation design', 'Story-driven UI messaging']
  },
  {
    id: 'whimsy-injector',
    group: 'design',
    title: 'Whimsy Injector',
    purpose: 'Introduces memorable personality without harming usability.',
    responsibilities: ['Delight moments', 'Micro-interaction ideas', 'Brand personality accents']
  },
  {
    id: 'experiment-tracker',
    group: 'project-management',
    title: 'Experiment Tracker',
    purpose: 'Tracks hypotheses, setup, outcomes, and follow-up actions.',
    responsibilities: ['Experiment logs', 'Result traceability', 'Next-step recommendations']
  },
  {
    id: 'project-shipper',
    group: 'project-management',
    title: 'Project Shipper',
    purpose: 'Keeps delivery focused on shipping outcomes.',
    responsibilities: ['Execution plans', 'Dependency management', 'Ship readiness checks']
  },
  {
    id: 'studio-producer',
    group: 'project-management',
    title: 'Studio Producer',
    purpose: 'Coordinates cross-functional production quality and pace.',
    responsibilities: ['Schedule coordination', 'Milestone tracking', 'Cross-team alignment']
  },
  {
    id: 'support-responder',
    group: 'studio-operations',
    title: 'Support Responder',
    purpose: 'Improves support workflows and response quality.',
    responsibilities: ['Issue triage', 'Response playbooks', 'Escalation criteria']
  },
  {
    id: 'analytics-reporter',
    group: 'studio-operations',
    title: 'Analytics Reporter',
    purpose: 'Builds clear metric narratives for decisions.',
    responsibilities: ['KPI summaries', 'Dashboard recommendations', 'Insight communication']
  },
  {
    id: 'infrastructure-maintainer',
    group: 'studio-operations',
    title: 'Infrastructure Maintainer',
    purpose: 'Maintains reliable and cost-efficient technical operations.',
    responsibilities: ['Runtime health checks', 'Infra hygiene', 'Reliability improvements']
  },
  {
    id: 'legal-compliance-checker',
    group: 'studio-operations',
    title: 'Legal Compliance Checker',
    purpose: 'Flags legal and policy risks in initiatives.',
    responsibilities: ['Policy checks', 'Regulatory risk flags', 'Mitigation recommendations']
  },
  {
    id: 'finance-tracker',
    group: 'studio-operations',
    title: 'Finance Tracker',
    purpose: 'Evaluates cost, ROI, and budget alignment.',
    responsibilities: ['Budget impact', 'Cost tracking', 'ROI framing']
  },
  {
    id: 'tool-evaluator',
    group: 'testing',
    title: 'Tool Evaluator',
    purpose: 'Assesses tool fit, gaps, and adoption tradeoffs.',
    responsibilities: ['Capability scoring', 'Fit-gap analysis', 'Adoption recommendations']
  },
  {
    id: 'api-tester',
    group: 'testing',
    title: 'API Tester',
    purpose: 'Validates backend API correctness and resilience.',
    responsibilities: ['Contract testing', 'Negative-path checks', 'Latency and error analysis']
  },
  {
    id: 'workflow-optimizer',
    group: 'testing',
    title: 'Workflow Optimizer',
    purpose: 'Finds waste and friction in development workflows.',
    responsibilities: ['Process diagnostics', 'Automation opportunities', 'Cycle-time reduction']
  },
  {
    id: 'performance-benchmarker',
    group: 'testing',
    title: 'Performance Benchmarker',
    purpose: 'Defines and runs reproducible performance benchmarks.',
    responsibilities: ['Benchmark plans', 'Regression detection', 'Performance tuning priorities']
  },
  {
    id: 'test-results-analyzer',
    group: 'testing',
    title: 'Test Results Analyzer',
    purpose: 'Turns noisy test output into root-cause-focused insights.',
    responsibilities: ['Failure clustering', 'Flake analysis', 'Remediation priorities']
  }
];
