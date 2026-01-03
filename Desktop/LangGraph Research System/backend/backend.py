"""
Voice Research System - Production Backend
Fixed: Actual research execution, proper completion detection, status management
"""

import os
import json
import asyncio
from typing import TypedDict, Annotated, List, Literal
from datetime import datetime
import operator
import re

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
import aiohttp

from dotenv import load_dotenv
load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================

app = FastAPI(title="Voice Research System - Production")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FIREWORKS_API_KEY = os.getenv("FIREWORKS_API_KEY")
VAPI_API_KEY = os.getenv("VAPI_API_KEY")

# ============================================================================
# GLOBAL STATE MANAGEMENT
# ============================================================================

class ResearchStatus:
    """Thread-safe research status tracker"""
    def __init__(self):
        self.statuses = {}
        self._lock = asyncio.Lock()
    
    async def set_status(self, call_id: str, status: dict):
        async with self._lock:
            self.statuses[call_id] = {
                **status,
                'updated_at': datetime.now().isoformat()
            }
            print(f"📊 Status updated for {call_id}: {status}")
    
    async def get_status(self, call_id: str) -> dict:
        async with self._lock:
            return self.statuses.get(call_id, {})
    
    async def mark_announced(self, call_id: str):
        async with self._lock:
            if call_id in self.statuses:
                self.statuses[call_id]['announced'] = True
                print(f"✅ Marked as announced: {call_id}")
    
    async def clear_status(self, call_id: str):
        async with self._lock:
            if call_id in self.statuses:
                del self.statuses[call_id]
                print(f"🗑️ Cleared status for {call_id}")

research_status = ResearchStatus()

# ============================================================================
# WEBSOCKET MANAGER
# ============================================================================

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"✅ WebSocket connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"📴 WebSocket disconnected. Remaining: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        for connection in self.active_connections[:]:
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"⚠️ Broadcast error: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

# ============================================================================
# AI & SEARCH SETUP
# ============================================================================

async def call_fireworks(messages: List[dict]) -> str:
    """Call Fireworks AI Kimi model"""
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://api.fireworks.ai/inference/v1/chat/completions",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {FIREWORKS_API_KEY}"
            },
            json={
                "model": "accounts/fireworks/models/kimi-k2-instruct-0905",
                "max_tokens": 4000,
                "top_p": 1,
                "top_k": 40,
                "presence_penalty": 0,
                "frequency_penalty": 0,
                "temperature": 0.3,
                "messages": messages,
            }
        ) as response:
            data = await response.json()
            
            if "error" in data:
                raise Exception(f"Fireworks API error: {data['error']}")
            
            if "choices" not in data:
                raise Exception(f"Unexpected API response: {data}")
            
            return data["choices"][0]["message"]["content"]

# ============================================================================
# DUCKDUCKGO SEARCH INTEGRATION
# ============================================================================

SEARCH_AVAILABLE = False
try:
    from duckduckgo_search import DDGS
    SEARCH_AVAILABLE = True
    print("✅ DuckDuckGo search module loaded")
except ImportError as e:
    print(f"⚠️ DuckDuckGo not available (install: pip install duckduckgo-search)")
    print(f"   Will use mock search results")

@tool
def web_search_tool(query: str) -> dict:
    """Performs REAL web search using DuckDuckGo"""
    if not SEARCH_AVAILABLE:
        return {
            "query": query,
            "summary": f"Mock research findings on '{query}' - Install duckduckgo-search for real results",
            "key_facts": [
                f"Mock finding 1: Overview of {query}",
                f"Mock finding 2: Current trends in {query}",
                f"Mock finding 3: Applications of {query}"
            ],
            "sources": ["Mock Source (Install duckduckgo-search for real sources)"],
            "reliability_score": 75
        }
    
    try:
        print(f"🔍 Searching DuckDuckGo for: '{query}'")
        
        results = []
        with DDGS() as ddgs:
            search_results = ddgs.text(query, max_results=5)
            for r in search_results:
                results.append(r)
        
        print(f"✅ Found {len(results)} results from DuckDuckGo")
        
        facts = []
        sources = []
        urls = []
        
        for result in results:
            title = result.get('title', '')
            snippet = result.get('body', '')
            url = result.get('href', '')
            
            if title and snippet:
                fact_text = f"{title}: {snippet[:200]}"
                facts.append(fact_text)
                print(f"   📄 {title[:60]}...")
                
            if url:
                sources.append(url)
                urls.append(url)
        
        if not facts:
            facts = [f"Search completed for '{query}' but no detailed results found"]
        
        primary_url = urls[0] if urls else None
        
        return {
            "query": query,
            "summary": f"Found {len(facts)} relevant results from DuckDuckGo for '{query}'",
            "key_facts": facts[:5],
            "sources": sources[:3] if sources else ["DuckDuckGo"],
            "url": primary_url,
            "all_urls": urls[:5],
            "reliability_score": 90 if len(facts) >= 3 else 75,
        }
        
    except Exception as e:
        print(f"❌ DuckDuckGo search error: {str(e)}")
        return {
            "query": query,
            "summary": f"Search error for '{query}': {str(e)}",
            "key_facts": ["Unable to complete search - please try again"],
            "sources": ["Search Unavailable"],
            "reliability_score": 50,
            "error": str(e)
        }

# ============================================================================
# LANGGRAPH STATE & NODES
# ============================================================================

class ResearchState(TypedDict):
    """State for the research workflow"""
    messages: Annotated[List, operator.add]
    query: str
    research_plan: dict
    worker_results: List[dict]
    synthesis: str
    objectives: List[str]
    confidence: str
    llm_calls: int
    current_step: str
    call_id: str

# ============================================================================
# LANGGRAPH NODES
# ============================================================================

async def supervisor_node(state: ResearchState) -> dict:
    """Supervisor agent - Creates research plan"""
    
    await manager.broadcast({
        "type": "node_update",
        "node": {"id": "supervisor", "label": "🧠 Supervisor Agent", "status": "active"}
    })
    
    await manager.broadcast({
        "type": "log",
        "message": "🧠 Supervisor: Creating comprehensive research plan...",
        "log_type": "supervisor"
    })
    
    query = state["query"]
    
    planning_prompt = f"""You are a research supervisor. Create a detailed research plan for: "{query}"

Provide:
1. 3-5 clear research objectives
2. 5-7 specific search queries to comprehensively research this topic
3. Expected information types

Respond ONLY with valid JSON in this exact format:
{{
    "objectives": ["objective1", "objective2", "objective3"],
    "search_queries": ["query1", "query2", "query3", "query4", "query5"],
    "info_types": ["type1", "type2"]
}}"""

    response = await call_fireworks([
        {"role": "system", "content": "You are a research planning expert. Respond only with valid JSON, no markdown, no explanations."},
        {"role": "user", "content": planning_prompt}
    ])
    
    try:
        plan_text = response.strip()
        if "```json" in plan_text:
            plan_text = plan_text.split("```json")[1].split("```")[0]
        elif "```" in plan_text:
            plan_text = plan_text.split("```")[1].split("```")[0]
        
        research_plan = json.loads(plan_text.strip())
        print(f"✅ Research plan created: {len(research_plan.get('search_queries', []))} queries")
        
    except Exception as e:
        print(f"⚠️ Plan parsing failed, using fallback: {e}")
        research_plan = {
            "objectives": [
                f"Understand fundamentals of {query}",
                f"Analyze current trends in {query}",
                f"Identify key applications of {query}"
            ],
            "search_queries": [
                f"{query} overview",
                f"{query} latest developments",
                f"{query} applications",
                f"{query} trends 2024",
                f"{query} research studies"
            ],
            "info_types": ["definitions", "trends", "applications"]
        }
    
    await manager.broadcast({
        "type": "log",
        "message": f"📋 Supervisor: Plan ready with {len(research_plan['search_queries'])} research tasks",
        "log_type": "supervisor"
    })
    
    await manager.broadcast({
        "type": "node_update",
        "node": {"id": "supervisor", "label": "🧠 Supervisor Agent", "status": "completed"}
    })
    
    return {
        "messages": state.get("messages", []),
        "research_plan": research_plan,
        "objectives": research_plan["objectives"],
        "worker_results": state.get("worker_results", []),
        "synthesis": state.get("synthesis", ""),
        "confidence": state.get("confidence", ""),
        "current_step": "workers",
        "llm_calls": state.get("llm_calls", 0) + 1,
        "call_id": state.get("call_id")
    }

async def workers_node(state: ResearchState) -> dict:
    """Worker agents - Execute research tasks"""
    
    research_plan = state["research_plan"]
    search_queries = research_plan["search_queries"][:5]
    
    await manager.broadcast({
        "type": "log",
        "message": f"🔧 Launching {len(search_queries)} research workers...",
        "log_type": "info"
    })
    
    worker_results = []
    
    for i, query in enumerate(search_queries):
        await manager.broadcast({
            "type": "node_update",
            "node": {
                "id": f"worker_{i+1}",
                "label": f"🤖 Worker {i+1}",
                "status": "researching",
                "query": query
            }
        })
        
        await manager.broadcast({
            "type": "log",
            "message": f"🤖 Worker {i+1}: Researching '{query}'...",
            "log_type": "worker"
        })
        
        result = web_search_tool.invoke({"query": query})
        
        worker_results.append({
            "worker_id": i + 1,
            "search_term": query,
            **result
        })
        
        await manager.broadcast({
            "type": "log",
            "message": f"✅ Worker {i+1}: Found {len(result.get('key_facts', []))} facts",
            "log_type": "success"
        })
        
        await manager.broadcast({
            "type": "node_update",
            "node": {
                "id": f"worker_{i+1}",
                "label": f"🤖 Worker {i+1}",
                "status": "completed",
                "query": query
            }
        })
        
        await asyncio.sleep(0.3)
    
    print(f"✅ All {len(worker_results)} workers completed")
    
    return {
        "messages": state.get("messages", []),
        "query": state.get("query", ""),
        "research_plan": state.get("research_plan", {}),
        "objectives": state.get("objectives", []),
        "worker_results": worker_results,
        "synthesis": state.get("synthesis", ""),
        "confidence": state.get("confidence", ""),
        "current_step": "quality",
        "llm_calls": state.get("llm_calls", 0),
        "call_id": state.get("call_id")
    }

async def quality_node(state: ResearchState) -> dict:
    """Quality assurance agent"""
    
    await manager.broadcast({
        "type": "node_update",
        "node": {"id": "quality", "label": "🔍 Quality Agent", "status": "active"}
    })
    
    await manager.broadcast({
        "type": "log",
        "message": "🔍 Quality Agent: Validating all sources...",
        "log_type": "quality"
    })
    
    await asyncio.sleep(1)
    
    worker_results = state.get("worker_results", [])
    valid_results = [r for r in worker_results if r.get("reliability_score", 0) >= 70]
    
    if not valid_results and worker_results:
        valid_results = worker_results
    
    await manager.broadcast({
        "type": "log",
        "message": f"✓ Quality Agent: Validated {len(valid_results)}/{len(worker_results)} sources",
        "log_type": "success"
    })
    
    await manager.broadcast({
        "type": "node_update",
        "node": {"id": "quality", "label": "🔍 Quality Agent", "status": "completed"}
    })
    
    return {
        "messages": state.get("messages", []),
        "query": state.get("query", ""),
        "research_plan": state.get("research_plan", {}),
        "objectives": state.get("objectives", []),
        "worker_results": valid_results,
        "synthesis": state.get("synthesis", ""),
        "confidence": state.get("confidence", ""),
        "current_step": "synthesis",
        "llm_calls": state.get("llm_calls", 0),
        "call_id": state.get("call_id")
    }

async def synthesis_node(state: ResearchState) -> dict:
    """Synthesis agent - Creates comprehensive report"""
    
    await manager.broadcast({
        "type": "node_update",
        "node": {"id": "synthesis", "label": "📝 Synthesis Agent", "status": "active"}
    })
    
    await manager.broadcast({
        "type": "log",
        "message": "📝 Synthesis Agent: Creating comprehensive report...",
        "log_type": "supervisor"
    })
    
    query = state["query"]
    worker_results = state.get("worker_results", [])
    
    if not worker_results:
        await manager.broadcast({
            "type": "log",
            "message": "⚠️ No valid results to synthesize",
            "log_type": "error"
        })
        
        return {
            "messages": state.get("messages", []),
            "query": state.get("query", ""),
            "research_plan": state.get("research_plan", {}),
            "objectives": state.get("objectives", []),
            "worker_results": state.get("worker_results", []),
            "synthesis": f"Research on '{query}' completed but found no valid results. Please try a different query or try again later.",
            "confidence": "Low (0%)",
            "current_step": "end",
            "llm_calls": state.get("llm_calls", 0),
            "call_id": state.get("call_id")
        }
    
    context_parts = []
    for i, result in enumerate(worker_results):
        context = f"""SOURCE {i+1}: {result['search_term']}
Summary: {result['summary']}
Key Facts: {', '.join(result.get('key_facts', [])[:3])}  
Reliability: {result.get('reliability_score', 0)}%"""
        context_parts.append(context)
    
    full_context = "\n\n---\n\n".join(context_parts)
    
    synthesis_prompt = f"""Create a comprehensive research report on: "{query}"

RESEARCH DATA FROM MULTIPLE SOURCES:
{full_context}

Structure your response with these sections:

1. EXECUTIVE SUMMARY (2-3 sentences highlighting the most important findings)

2. KEY FINDINGS (5-7 bullet points of critical insights)

3. DETAILED ANALYSIS (2-3 well-developed paragraphs exploring the topic in depth)

4. IMPLICATIONS (1-2 paragraphs discussing practical applications and significance)

5. CONFIDENCE ASSESSMENT (Brief note on data quality)

Be comprehensive, insightful, and synthesize information from all sources. Use clear, professional language."""

    response = await call_fireworks([
        {"role": "system", "content": "You are an expert research analyst who creates comprehensive, well-structured reports. Be thorough and insightful."},
        {"role": "user", "content": synthesis_prompt}
    ])
    
    synthesis = response
    
    avg_reliability = sum(r.get("reliability_score", 0) for r in worker_results) / len(worker_results)
    
    if avg_reliability >= 85:
        confidence = "High (90%)"
    elif avg_reliability >= 75:
        confidence = "Medium-High (82%)"
    else:
        confidence = "Medium (72%)"
    
    print(f"✅ Synthesis complete: {len(synthesis)} characters, {confidence} confidence")
    
    await manager.broadcast({
        "type": "log",
        "message": "✅ Synthesis complete! Report ready for export.",
        "log_type": "success"
    })
    
    await manager.broadcast({
        "type": "node_update",
        "node": {"id": "synthesis", "label": "📝 Synthesis Agent", "status": "completed"}
    })
    
    return {
        "messages": state.get("messages", []),
        "query": state.get("query", ""),
        "research_plan": state.get("research_plan", {}),
        "objectives": state.get("objectives", []),
        "worker_results": state.get("worker_results", []),
        "synthesis": synthesis,
        "confidence": confidence,
        "current_step": "end",
        "llm_calls": state.get("llm_calls", 0) + 1,
        "call_id": state.get("call_id")
    }

# ============================================================================
# LANGGRAPH WORKFLOW
# ============================================================================

def should_continue(state: ResearchState) -> Literal["workers", "quality", "synthesis", END]:
    step = state.get("current_step", "supervisor")
    
    if step == "workers":
        return "workers"
    elif step == "quality":
        return "quality"
    elif step == "synthesis":
        return "synthesis"
    else:
        return END

def build_research_graph():
    """Build the research workflow graph"""
    workflow = StateGraph(ResearchState)
    
    workflow.add_node("supervisor", supervisor_node)
    workflow.add_node("workers", workers_node)
    workflow.add_node("quality", quality_node)
    workflow.add_node("synthesis", synthesis_node)
    
    workflow.add_edge(START, "supervisor")
    workflow.add_conditional_edges("supervisor", should_continue, ["workers", END])
    workflow.add_conditional_edges("workers", should_continue, ["quality", END])
    workflow.add_conditional_edges("quality", should_continue, ["synthesis", END])
    workflow.add_edge("synthesis", END)
    
    memory = MemorySaver()
    return workflow.compile(checkpointer=memory)

research_graph = build_research_graph()
print("✅ Research graph compiled successfully")

# ============================================================================
# RESEARCH EXECUTION - FIXED TO ACTUALLY RUN
# ============================================================================

async def run_research(query: str, call_id: str = None):
    """
    Execute ACTUAL research workflow
    """
    try:
        print(f"\n{'='*80}")
        print(f"🔬 RESEARCH STARTED | Query: '{query}' | Call ID: {call_id}")
        print(f"{'='*80}\n")

        if call_id:
            # Clear old results on frontend
            await manager.broadcast({
                "type": "clear_results"
            })
            
            # Initialize status
            await research_status.set_status(call_id, {
                "complete": False,
                "in_progress": True,
                "query": query,
                "started_at": datetime.now().isoformat(),
                "announced": False,
                "results": None
            })

        # **CRITICAL FIX: Actually run the research graph**
        initial_state = {
            "messages": [],
            "query": query,
            "research_plan": {},
            "worker_results": [],
            "synthesis": "",
            "objectives": [],
            "confidence": "",
            "llm_calls": 0,
            "current_step": "supervisor",
            "call_id": call_id
        }
        
        # Run the graph
        config = {"configurable": {"thread_id": call_id or "default"}}
        final_state = None
        
        async for state in research_graph.astream(initial_state, config):
            final_state = state
            print(f"📊 Graph step completed: {list(state.keys())}")
        
        # Extract final results
        if final_state:
            # Get the last node's state
            last_node_key = list(final_state.keys())[-1]
            result_state = final_state[last_node_key]
            
            # Prepare results
            results = {
                "query": result_state.get("query", query),
                "summary": result_state.get("synthesis", "")[:500],  # First 500 chars for summary
                "fullSynthesis": result_state.get("synthesis", ""),
                "synthesis": result_state.get("synthesis", ""),
                "sources": [
                    {
                        "name": r.get("search_term", ""),
                        "search_term": r.get("search_term", ""),
                        "summary": r.get("summary", ""),
                        "key_facts": r.get("key_facts", []),
                        "reliability": r.get("reliability_score", 0),
                        "reliability_score": r.get("reliability_score", 0),
                        "url": r.get("url", "")
                    }
                    for r in result_state.get("worker_results", [])
                ],
                "objectives": result_state.get("objectives", []),
                "confidence": result_state.get("confidence", "Unknown"),
                "timestamp": datetime.now().isoformat(),
                "llm_calls": result_state.get("llm_calls", 0),
                "call_id": call_id
            }
            
            # Broadcast results to frontend
            await manager.broadcast({
                "type": "result",
                "data": results
            })
            
            # Mark research as complete
            if call_id:
                await research_status.set_status(call_id, {
                    "complete": True,
                    "in_progress": False,
                    "completed_at": datetime.now().isoformat(),
                    "results": results,
                    "query": query,
                    "source_count": len(results["sources"]),
                    "confidence": results["confidence"],
                    "announced": False  # Not announced yet
                })

            print(f"🎉 RESEARCH COMPLETED SUCCESSFULLY | Query: {query} | Call ID: {call_id}\n")

    except Exception as e:
        print(f"\n❌ RESEARCH ERROR | Query: {query} | Call ID: {call_id} | Error: {e}\n")
        import traceback
        traceback.print_exc()

        if call_id:
            await research_status.set_status(call_id, {
                "complete": False,
                "in_progress": False,
                "error": str(e),
                "failed_at": datetime.now().isoformat()
            })
        
        await manager.broadcast({
            "type": "error",
            "message": f"Research failed: {str(e)}"
        })

# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get("/")
async def root():
    return {
        "system": "Voice Research System - Production",
        "version": "2.0",
        "status": "online",
        "endpoints": {
            "health": "/health",
            "webhook_research": "/webhook/research",
            "webhook_status": "/webhook/check_status",
            "websocket": "/ws"
        }
    }

@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "system": "Voice Research System",
        "model": "Fireworks AI - Kimi K2",
        "search": "DuckDuckGo (Real-time)" if SEARCH_AVAILABLE else "Mock Search",
        "features": ["voice", "vapi", "real_time", "multi_agent", "pdf", "docx", "md"],
        "timestamp": datetime.now().isoformat()
    }

@app.get("/status/{call_id}")
async def get_status(call_id: str):
    status = await research_status.get_status(call_id)
    return {
        "call_id": call_id,
        "status": status if status else {"message": "No research found for this call"}
    }

# ============================================================================
# VAPI WEBHOOKS
# ============================================================================
@app.post("/webhook/research")
async def research_webhook(request: Request):
    """
    Handle Vapi function call: start_research
    """
    try:
        payload = await request.json()
        print("\n📥 WEBHOOK RECEIVED:\n", json.dumps(payload, indent=2), "\n")

        message = payload.get("message", {})
        tool_calls = message.get("toolCalls", [])
        call_id = payload.get("call", {}).get("id") or payload.get("callId") or "unknown_call_id"

        query = None

        for tc in tool_calls:
            fn = tc.get("function", {})
            if fn.get("name") == "start_research":
                args = fn.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                if isinstance(args, dict):
                    query = args.get("query")
                if query:
                    break

        if not query:
            call_args = payload.get("call", {}).get("arguments")
            if isinstance(call_args, dict):
                query = call_args.get("query")

        if not query:
            content = message.get("content", "")
            if isinstance(content, str) and content.strip():
                match = re.search(r"research (?:about )?(.*)", content, re.IGNORECASE)
                if match:
                    query = match.group(1).strip()

        if not query:
            print("❌ WARNING: No query found in request!")
            return {
                "results": [{
                    "toolCallId": tool_calls[0].get("id") if tool_calls else "unknown",
                    "result": "I didn't catch the research topic. Could you please tell me what you'd like me to research?"
                }]
            }

        if not call_id or call_id == "unknown_call_id":
            print("⚠️ WARNING: No call_id found! Voice notification may not work.\n")

        # Clear old research for this call
        await research_status.clear_status(call_id)

        # Start research asynchronously
        print(f"🚀 Starting research task...\n   Query: '{query}'\n   Call ID: {call_id}\n")
        asyncio.create_task(run_research(query, call_id))

        # Return in Vapi-expected format
        tool_call_id = tool_calls[0].get("id") if tool_calls else "unknown"
        
        return {
            "results": [{
                "toolCallId": tool_call_id,
                "result": f"Perfect! I'm starting comprehensive research on {query}. This will take about 30 to 60 seconds. My multi-agent system is gathering and analyzing information from multiple sources. I'll let you know as soon as the report is ready on your dashboard."
            }]
        }

    except Exception as e:
        print(f"\n❌ WEBHOOK ERROR: {str(e)}\n")
        import traceback
        traceback.print_exc()
        return {
            "results": [{
                "toolCallId": tool_calls[0].get("id") if tool_calls else "unknown",
                "result": "I encountered a technical error. Could you please try your research request again?"
            }]
        }

@app.post("/webhook/check_status")
async def check_research_status_webhook(request: Request):
    """
    Handle Vapi function call: check_research_status
    """
    try:
        payload = await request.json()
        
        print("\n" + "="*80)
        print("📊 STATUS CHECK REQUEST")
        print("="*80)
        
        message = payload.get("message", {})
        message_call = message.get("call", {})
        call_id = message_call.get("id") if message_call else None
        
        if not call_id:
            call_id = payload.get("call", {}).get("id")
        
        if not call_id:
            call_id = message.get("callId") or message.get("call_id")
        
        print(f"📞 Call ID: {call_id}")
        
        if not call_id:
            print("❌ No call_id found\n")
            return {"result": "no_call_id"}
        
        status = await research_status.get_status(call_id)
        
        print(f"📊 Current Status: {json.dumps(status, indent=2)}")
        
        # **CRITICAL: Return completion status in format Vapi can understand**
        if status.get('complete') and not status.get('announced'):
            await research_status.mark_announced(call_id)
            
            source_count = status.get('source_count', 0)
            confidence = status.get('confidence', 'Unknown')
            query = status.get('query', 'your topic')
            
            result_message = (
                f"Research on {query} is complete! "
                f"Found {source_count} sources with {confidence} confidence. "
                f"Your detailed report is ready on the dashboard. "
                f"Would you like to research another topic?"
            )
            
            print(f"\n✅ ANNOUNCING COMPLETION!")
            print(f"   Message: {result_message}\n")
            
            return {"result": result_message}
        
        elif status.get('complete') and status.get('announced'):
            print("ℹ️ Already announced\n")
            return {"result": "already_announced"}
        
        elif status.get('error'):
            error_msg = status.get('error', 'Unknown error')
            print(f"❌ Research failed: {error_msg}\n")
            return {
                "result": f"Research encountered an error: {error_msg}. Want to try again?"
            }
        
        elif status.get('in_progress'):
            print("⏳ Still in progress\n")
            return {"result": "still_in_progress"}
        
        else:
            print("❓ No research found\n")
            return {"result": "no_research_started"}
            
    except Exception as e:
        print(f"\n❌ STATUS CHECK ERROR: {str(e)}\n")
        import traceback
        traceback.print_exc()
        
        return {"result": "error_checking_status"}
# Add this AFTER the check_research_status_webhook function (around line 550)

# REPLACE the poll_status endpoint (around line 850) with this:

@app.post("/webhook/poll_status")
async def poll_research_status(request: Request):
    """Polling endpoint for Vapi"""
    try:
        payload = await request.json()
        
        call_id = (payload.get("message", {}).get("call", {}).get("id") or 
                   payload.get("call", {}).get("id") or 
                   payload.get("callId"))
        
        print(f"🔄 POLL | Call ID: {call_id}")
        
        if not call_id:
            return {"result": "still_in_progress"}
        
        status = await research_status.get_status(call_id)
        
        # Research complete and not announced
        if status.get('complete') and not status.get('announced'):
            await research_status.mark_announced(call_id)
            
            source_count = status.get('source_count', 0)
            confidence = status.get('confidence', 'Unknown')
            query = status.get('query', 'your topic')
            
            result_message = (
                f"Great news! Your research on {query} is complete. "
                f"I found {source_count} high-quality sources with {confidence} confidence. "
                f"Your comprehensive report is ready on the dashboard. "
                f"You can export it as PDF, Word, or Markdown. "
                f"Would you like to research another topic?"
            )
            
            print(f"✅ ANNOUNCING: {result_message[:80]}...")
            
            # Return in format Vapi expects
            return {"result": result_message}
        
        # Already announced
        elif status.get('complete') and status.get('announced'):
            return {"result": "already_announced"}
        
        # Error occurred
        elif status.get('error'):
            return {
                "result": f"Research encountered an error: {status.get('error')}. Would you like to try again?"
            }
        
        # Still in progress
        elif status.get('in_progress'):
            return {"result": "still_in_progress"}
        
        # Not started yet
        else:
            return {"result": "still_in_progress"}
            
    except Exception as e:
        print(f"❌ POLL ERROR: {e}")
        return {"result": "still_in_progress"}
# ============================================================================
# WEBSOCKET ENDPOINT
# ============================================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    
    try:
        while True:
            data = await websocket.receive_text()
            
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        print("📴 WebSocket client disconnected")
        
    except Exception as e:
        print(f"❌ WebSocket error: {e}")
        manager.disconnect(websocket)

# ============================================================================
# SERVER STARTUP
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    print("""
╔══════════════════════════════════════════════════════════════════════════╗
║                                                                          ║
║          🎤 VOICE RESEARCH SYSTEM - PRODUCTION BACKEND 🎤                ║
║                                                                          ║
║  Status: Ready for Production                                           ║
║  Model: Fireworks AI - Kimi K2 Instruct                                 ║
║  Search: """ + ("DuckDuckGo (Real-time)" if SEARCH_AVAILABLE else "Mock Search") + """                                                ║
║  Multi-Agent: LangGraph with 4 specialized agents                       ║
║                                                                          ║
║  🌐 Endpoints:                                                           ║
║     • Server:    http://localhost:8001                                  ║
║     • Health:    http://localhost:8001/health                           ║
║     • WebSocket: ws://localhost:8001/ws                                 ║
║                                                                          ║
║  🎤 Vapi Webhooks:                                                       ║
║     • Research:  http://localhost:8001/webhook/research                 ║
║     • Status:    http://localhost:8001/webhook/check_status             ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝
    """)
    
    if not FIREWORKS_API_KEY:
        print("\n⚠️  WARNING: FIREWORKS_API_KEY not found!")
        print("   Set it in .env file\n")
    else:
        print("✅ Fireworks API key loaded\n")
    
    if not SEARCH_AVAILABLE:
        print("⚠️  DuckDuckGo not available - using mock search\n")
    else:
        print("✅ DuckDuckGo search enabled\n")
    
    print("🚀 Starting server on http://localhost:8001\n")
    
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=8001, 
        log_level="info",
        access_log=True
    )
