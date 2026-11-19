# ThermaStock — Literature & Reference Sources (SOURCES)

> Mọi tham số trong `SpeciesProfile` (bao gồm `SpeciesProfile.controller`) có `source: "literature"` hoặc thẻ gợi ý dinh dưỡng (`R1–R5`) đều trỏ tới một trong các mã nguồn `S1–S10` dưới đây. Các tham số không có trong danh mục này được đánh dấu `source: "assumption"` và liệt kê trong [ASSUMPTIONS.md](./ASSUMPTIONS.md).

## Danh mục nguồn tham khảo

### `S1` — Omomowo & Falayi (2021), CIGR Journal
- **Trích dẫn**: Omomowo, O. I., & Falayi, F. R. (2021). *Temperature-Humidity Index (THI) and heat stress classification for broiler chickens* (citing Marai et al., 2001 and Duduyemi & Oseni, 2012). CIGR Journal.
- **URL**: https://cigrjournal.org/index.php/Ejounral/article/download/6425/3677
- **Nội dung sử dụng trong hệ thống**:
  - Công thức đăng ký `marai2001`: $\text{THI} = T - (0.31 - 0.31 \times \text{RH}) \times (T - 14.4)$, với $T$ tính bằng °C và $\text{RH}$ là phân số ($\text{RH}\% / 100$).
  - 3 mức phân loại stress nhiệt gà thịt (trích lại từ Duduyemi & Oseni, 2012):
    - $\text{THI} < 26$: `Comfort`
    - $26 \le \text{THI} \le 29$: `Heat stress`
    - $\text{THI} > 29$: `Severe heat stress`
  - Hệ số tham khảo `(0.85, 0.15)` cho công thức kết hợp bầu khô – bầu ướt (`dbwb`).

### `S2` — Gates, Zhang, Colliver, Overhults (1995), Transactions of the ASAE
- **Trích dẫn**: Gates, R. S., Zhang, H., Colliver, D. G., & Overhults, D. G. (1995). *Regional variation in temperature humidity index for poultry housing*. Transactions of the ASAE, 38(1), 197–205.
- **URL**: https://core.ac.uk/download/232585126.pdf
- **Nội dung sử dụng trong hệ thống**:
  - Công thức đăng ký `dbwb`: $\text{THI} = 0.6 \times T_{db} + 0.4 \times T_{wb}$ (°C).
  - Ngưỡng tham khảo `28` là điểm bắt đầu stress nhiệt (tác giả lưu ý đây là xấp xỉ cho gà thịt).

### `S3` — UGA Extension, Bulletin B 1287
- **Trích dẫn**: University of Georgia Cooperative Extension. *Broiler Production & Management (Bulletin B 1287)*.
- **URL**: https://fieldreport.caes.uga.edu/wp-content/uploads/2025/08/B-1287_5.pdf
- **Nội dung sử dụng trong hệ thống**:
  - Nhiệt độ mục tiêu theo ngày tuổi (`targetTempByAge`, cột conventional brooder):
    - Ngày 0: `32 °C`
    - Ngày 3: `31 °C`
    - Ngày 7: `30 °C`
    - Ngày 14: `29 °C`
    - Ngày 21: `27 °C`
  - Dải độ ẩm tham chiếu trong chuồng (`humidityComfortRange`): `50%–70%`.

### `S4` — Frontiers in Physiology (2022) Review
- **Trích dẫn**: *A review of heat stress in chickens. Part II: Nutritional and feeding strategies*. Frontiers in Physiology (2022).
- **URL**: https://www.frontiersin.org/articles/10.3389/fphys.2022.943612
- **Nội dung sử dụng trong hệ thống**:
  - Ngừng cấp cám $\ge 6$ giờ trong khung nóng giúp giảm thân nhiệt; kèm lưu ý bằng chứng về tăng trọng không nhất quán và nguy cơ gà ăn dồn trước giờ nóng.
  - Nội dung thẻ gợi ý `R1` (tăng mật độ năng lượng ME 100–200 kcal/kg, chất béo, trích Ghazalah và cs. 2008), `R2` (protein thô và cân bằng amino acid tổng hợp), `R5` (cám viên so với cám bột).

### `S5` — Farming Portal (South Africa) — Nguồn thương mại, thứ cấp
- **Trích dẫn**: Farming Portal. *The effect of heat stress on broiler performance and strategies to reduce this effect*.
- **URL**: https://www.farmingportal.co.za/index.php/agri-index/69-animals/2371-the-effect-of-heat-stress-on-broiler-performance-and-strategies-to-reduce-this-effect
- **Nội dung sử dụng trong hệ thống**:
  - Mốc tuổi: từ 3 tuần tuổi (`21 ngày`), trên `25 °C` gà bắt đầu khó tản nhiệt.
  - Khung ngừng cấp cám: bắt đầu ít nhất `3 giờ` trước đỉnh nóng (`lead = 3`) và tiếp tục `3 giờ` sau đỉnh nóng (`lag = 3`).
  - Nhiệt độ nước uống: giữ nước sạch và mát dưới `25 °C` (gà giảm uống khi nước trên `24 °C`).

### `S6` — Zootecnica International — Nguồn thương mại
- **Trích dẫn**: Zootecnica International. *Broiler management and feed formulation approaches in hot environments*.
- **URL**: https://zootecnicainternational.com/poultry-facts/broiler-management-and-feed-formulation-approaches-in-hot-environments/
- **Nội dung sử dụng trong hệ thống**:
  - Nội dung thẻ gợi ý `R1` (mức ME/fat tham khảo), `R3` (không áp dụng cách giảm xơ như động vật nhai lại; hướng dùng enzyme phân giải NSP), `R4` (điện giải tối thiểu theo Cobb: Na `0.16–0.23%`, Cl `0.16–0.30%`, K `0.60–0.95%`, vitamin E, vitamin C, betaine), `R5` (tỷ lệ hạt mịn `< 1000 µm` không quá `10–15%`, độ bền viên `> 95%`).

### `S7` — Aviagen, Tunnel Ventilation Poster
- **Trích dẫn**: Aviagen. *Key Factors for Managing Tunnel Ventilation in Broilers (Poster)*.
- **URL**: https://pt-eu.aviagen.com/assets/Tech_Center/BB_Resources_Tools/Poster-TunnelVentilation-Broilers-EN.pdf
- **Nội dung sử dụng trong hệ thống**:
  - Mục tiêu tốc độ gió trung bình trong chuồng thông gió hầm (tunnel ventilation): `2.5–3.0 m/s` (`vFullMps = 3.0`).
  - Ràng buộc cứng cho phun sương làm mát: chỉ cho phép phun sương khi độ ẩm môi trường ngoài trời/cửa hút gió `< 75%` (`mistMaxAmbientRH = 75`) **VÀ** tốc độ gió trong chuồng $\ge 1.5\text{ m/s}$ (`mistMinAirSpeedMps = 1.5`).

### `S8` — Furlan và cs. (2000), Journal of Applied Poultry Research
- **Trích dẫn**: Furlan, R. L., Macari, M., Secato, E. R., Guerreiro, J. R., & Malheiros, E. B. (2000). *Air velocity and exposure time to ventilation affect body surface and rectal temperature of broiler chickens*. Journal of Applied Poultry Research, 9(1), 1–5.
- **URL**: https://repositorio.unesp.br/items/59b5817a-7652-4228-8cf7-9bbf69b3a17e
- **Nội dung sử dụng trong hệ thống**:
  - Cơ sở sinh lý cho mô hình THI hiệu dụng ($\text{eTHI}$): tốc độ gió và thời gian tiếp xúc ảnh hưởng trực tiếp tới khả năng thoát nhiệt và thân nhiệt gà thịt; tốc độ gió `2 m/s` ở `29 °C` cải thiện rõ rệt khả năng thoát nhiệt của gà 36–42 ngày tuổi với phản ứng giảm nhiệt bề mặt rõ rệt ngay trong `10 phút` đầu.

### `S9` — Fabrico, VFD Energy Savings
- **Trích dẫn**: Fabrico. *VFD Energy Savings & Fan Affinity Laws*.
- **URL**: https://www.fabrico.io/blog/vfd-energy-savings/
- **Nội dung sử dụng trong hệ thống**:
  - Định luật đồng dạng quạt (Affinity Law): công suất điện tiêu thụ của quạt biến tần tỉ lệ xấp xỉ lập phương tốc độ quay ($P = P_{\text{rated}} \times f^3$; ví dụ chạy ở `80%` tốc độ thì công suất còn khoảng $0.8^3 = 51.2\%$).
  - Lưu ý kỹ thuật: định luật lập phương chỉ là xấp xỉ lý tưởng; hiệu suất mô-tơ/biến tần và áp suất tĩnh thực tế làm mức tiết kiệm ở tốc độ thấp kém hơn lý thuyết một chút.

### `S10` — Open-Meteo Weather Forecast API
- **Trích dẫn**: Open-Meteo. *Free Open-Source Weather API (`https://api.open-meteo.com/v1/forecast`)*.
- **URL**: https://open-meteo.com/
- **Nội dung sử dụng trong hệ thống**:
  - API dự báo thời tiết miễn phí không cần API key, giới hạn `10,000 lượt gọi/ngày` cho mục đích phi thương mại.
  - Dữ liệu phát hành theo giấy phép **CC BY 4.0** $\rightarrow$ bắt buộc hiển thị dòng ghi công `"Weather data by Open-Meteo.com"` ở footer giao diện khi sử dụng.
