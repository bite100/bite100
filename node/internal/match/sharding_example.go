package match

// 此文件展示如何使用分片路由功能（方案 B）
//
// 使用示例：
//
// 1. 创建路由和注册表
//    router := match.NewRouter(localPeerID, localEngine)
//    registry := match.NewRegistry(router, localPeerID, []string{"TKA/TKB"}, publishFunc)
//    registry.Start()
//
// 2. 订阅节点注册消息
//    // 在 sync.OrderSubscriber 中添加：
//    topic := "/p2p-exchange/match/register"
//    // 收到消息后调用：
//    registry.HandleRegistration(msg.Data)
//
// 3. 路由订单
//    needForward, targetPeerID, err := router.RouteOrder(order)
//    if needForward {
//        // 转发到 targetPeerID
//        forwardOrderToNode(targetPeerID, order)
//    } else {
//        // 本地处理
//        localEngine.AddOrder(order)
//        trades := localEngine.Match(order)
//    }
//
// 4. 定期清理过期节点
//    router.CleanupStaleNodes()
