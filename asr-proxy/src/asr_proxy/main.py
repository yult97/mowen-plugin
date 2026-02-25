"""
ASR Proxy 主入口
火山引擎流式 ASR 中转代理服务
"""

from .ws_server import run


def main():
    """主入口函数"""
    run()


if __name__ == "__main__":
    main()
