// main.ts - Deno Grok代理服务
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.208.0/http/file_server.ts";

interface AccountConfig {
  cookies: string;
  userAgent?: string;
}

// 账号配置 - 部署时通过环境变量设置
const ACCOUNTS: Record<string, AccountConfig> = {
  account1: {
    cookies: Deno.env.get("ACCOUNT1_COOKIES") || "",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  },
  account2: {
    cookies: Deno.env.get("ACCOUNT2_COOKIES") || "",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  },
  account3: {
    cookies: Deno.env.get("ACCOUNT3_COOKIES") || "",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  }
};

// CORS头部
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-account-id",
};

// 处理CORS预检请求
function handleCORS(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }
  return null;
}

// 代理Grok请求
async function proxyGrokRequest(request: Request, accountId: string): Promise<Response> {
  try {
    const account = ACCOUNTS[accountId];
    if (!account || !account.cookies) {
      return new Response(
        JSON.stringify({ error: `Account ${accountId} not configured or missing cookies` }),
        { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    const url = new URL(request.url);
    const targetPath = url.searchParams.get("path") || "";
    const grokUrl = `https://grok.x.ai${targetPath}`;

    console.log(`Proxying request to: ${grokUrl} for account: ${accountId}`);

    // 构建请求头
    const headers: HeadersInit = {
      "Cookie": account.cookies,
      "User-Agent": account.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      "DNT": "1",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Cache-Control": "max-age=0",
    };

    // 如果是POST请求，复制请求体和相关头部
    let body = undefined;
    if (request.method === "POST") {
      body = await request.text();
      headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
      headers["Content-Length"] = body.length.toString();
    }

    const response = await fetch(grokUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual", // 手动处理重定向
    });

    // 处理重定向
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (location) {
        return Response.redirect(location, response.status);
      }
    }

    // 获取响应内容
    let responseBody = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "";

    // 如果是HTML内容，需要修改其中的链接
    if (contentType.includes("text/html")) {
      let htmlContent = new TextDecoder().decode(responseBody);
      
      // 替换页面中的链接，让它们通过代理
      htmlContent = htmlContent
        .replace(/href="\/([^"]+)"/g, `href="/proxy?account=${accountId}&path=/$1"`)
        .replace(/src="\/([^"]+)"/g, `src="/proxy?account=${accountId}&path=/$1"`)
        .replace(/url\(\/([^)]+)\)/g, `url(/proxy?account=${accountId}&path=/$1)`)
        // 添加一些自定义样式来标识当前账号
        .replace(
          "<head>",
          `<head>
          <style>
            body::before {
              content: "Account: ${accountId}";
              position: fixed;
              top: 10px;
              right: 10px;
              background: rgba(29, 155, 240, 0.8);
              color: white;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              z-index: 9999;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
          </style>`
        );
      
      responseBody = new TextEncoder().encode(htmlContent).buffer;
    }

    // 构建响应头
    const responseHeaders = new Headers(corsHeaders);
    
    // 复制重要的响应头
    const headersToKeep = [
      "Content-Type", "Content-Length", "Set-Cookie", 
      "Cache-Control", "Expires", "Last-Modified", "ETag"
    ];
    
    headersToKeep.forEach(headerName => {
      const headerValue = response.headers.get(headerName);
      if (headerValue) {
        responseHeaders.set(headerName, headerValue);
      }
    });

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(
      JSON.stringify({ 
        error: "Proxy request failed", 
        details: error.message,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
}

// 主请求处理器
async function handler(request: Request): Promise<Response> {
  // 处理CORS
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const url = new URL(request.url);
  const pathname = url.pathname;

  console.log(`${request.method} ${pathname}`);

  // API路由
  if (pathname.startsWith("/api/")) {
    const apiPath = pathname.replace("/api", "");
    
    switch (apiPath) {
      case "/accounts":
        // 返回可用账号列表
        const availableAccounts = Object.keys(ACCOUNTS).filter(
          key => ACCOUNTS[key].cookies
        );
        return new Response(
          JSON.stringify({ accounts: availableAccounts }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      case "/health":
        return new Response(
          JSON.stringify({ 
            status: "ok", 
            timestamp: new Date().toISOString(),
            accounts: Object.keys(ACCOUNTS).reduce((acc, key) => {
              acc[key] = { configured: !!ACCOUNTS[key].cookies };
              return acc;
            }, {} as Record<string, { configured: boolean }>)
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      default:
        return new Response(
          JSON.stringify({ error: "API endpoint not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  }

  // 代理路由
  if (pathname === "/proxy") {
    const accountId = url.searchParams.get("account") || "account1";
    return await proxyGrokRequest(request, accountId);
  }

  // 直接账号访问路由
  if (pathname.startsWith("/account")) {
    const accountId = pathname.substring(1); // 移除开头的 '/'
    if (ACCOUNTS[accountId]) {
      // 重定向到Grok主页，通过代理
      const grokMainUrl = `/proxy?account=${accountId}&path=/`;
      return Response.redirect(grokMainUrl, 302);
    }
  }

  // 静态文件服务 - 服务前端文件
  return await serveDir(request, {
    fsRoot: "./public",
    urlRoot: "",
    enableCors: true,
  });
}

// 启动服务器
const port = parseInt(Deno.env.get("PORT") || "8000");

console.log(`🚀 Grok代理服务启动在端口 ${port}`);
console.log(`📁 静态文件目录: ./public`);
console.log(`🔐 已配置账号: ${Object.keys(ACCOUNTS).filter(k => ACCOUNTS[k].cookies).join(", ")}`);

await serve(handler, { port });